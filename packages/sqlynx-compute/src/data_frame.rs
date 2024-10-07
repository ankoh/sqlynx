use std::{collections::HashSet, sync::Arc};

use arrow::array::ArrowNativeTypeOp;
use arrow::array::RecordBatch;
use arrow::datatypes::i256;
use arrow::datatypes::DataType;
use arrow::datatypes::Schema;
use arrow::datatypes::TimeUnit;
use datafusion_common::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_expr::AggregateUDF;
use datafusion_expr::Operator;
use datafusion_functions::math::floor;
use datafusion_functions::unicode::character_length;
use datafusion_functions_aggregate::average::Avg;
use datafusion_functions_aggregate::count::count_udaf;
use datafusion_functions_aggregate::min_max::Max;
use datafusion_functions_aggregate::min_max::Min;
use datafusion_functions_nested::length::array_length_udf;
use datafusion_physical_expr::PhysicalExpr;
use datafusion_physical_expr::PhysicalSortExpr;
use datafusion_physical_expr::aggregate::AggregateExprBuilder;
use datafusion_physical_expr::aggregate::AggregateFunctionExpr;
use datafusion_physical_expr::expressions::CastExpr;
use datafusion_physical_expr::expressions::binary;
use datafusion_physical_expr::expressions::col;
use datafusion_physical_expr::expressions::lit;
use datafusion_physical_expr::ScalarFunctionExpr;
use datafusion_physical_plan::projection::ProjectionExec;
use datafusion_physical_plan::ExecutionPlan;
use datafusion_physical_plan::aggregates::{AggregateMode, AggregateExec, PhysicalGroupBy};
use datafusion_physical_plan::collect;
use datafusion_physical_plan::memory::MemoryExec;
use datafusion_physical_plan::sorts::sort::SortExec;
use prost::Message;
use wasm_bindgen::prelude::*;

use crate::arrow_out::DataFrameIpcStream;
use crate::proto::sqlynx_compute::GroupByKey;
use crate::proto::sqlynx_compute::GroupByKeyBinning;
use crate::proto::sqlynx_compute::{DataFrameTransform, GroupByTransform, OrderByTransform, AggregationFunction};

#[wasm_bindgen]
pub struct DataFrame {
    pub(crate) schema: Arc<Schema>,
    pub(crate) partitions: Vec<Vec<RecordBatch>>,
}

#[wasm_bindgen]
impl DataFrame {
    /// Construct a data frame
    pub(crate) fn new(schema: Arc<Schema>, batches: Vec<RecordBatch>) -> DataFrame {
        Self {
            schema, partitions: vec![batches]
        }
    }
    /// Scan the data frame
    #[wasm_bindgen(js_name="createIpcStream")]
    pub fn create_ipc_stream(&self) -> Result<DataFrameIpcStream, JsError> {
        DataFrameIpcStream::new(self.schema.clone())
    }

    /// Order a data frame
    async fn order_by(&self, config: &OrderByTransform, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<SortExec> {
        let mut sort_exprs: Vec<PhysicalSortExpr> = Vec::new();
        for constraint in config.constraints.iter() {
            let sort_options = arrow::compute::SortOptions {
                descending: !constraint.ascending,
                nulls_first: constraint.nulls_first,
            };
            sort_exprs.push(PhysicalSortExpr {
                expr: col(&constraint.field_name, &input.schema())?,
                options: sort_options,
            });
        }
        let sort_limit = config.limit.map(|l| l as usize);
        let sort_exec = SortExec::new(
            sort_exprs,
            input,
        ).with_fetch(sort_limit);
        return Ok(sort_exec);
    }

    /// Compute bin
    fn compute_bin(&self, key: &GroupByKey, key_binning: &GroupByKeyBinning, stats: &DataFrame, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<BinnedExpression> {
        // Unexpected schema for statistics frame?
        if stats.partitions.is_empty() || stats.partitions[0].is_empty() || stats.partitions[0][0].num_rows() != 1 {
            return Err(anyhow::anyhow!("statistics data must have exactly 1 row"));
        }
        let stats_batch = &stats.partitions[0][0];
        let stats_schema = stats_batch.schema_ref();
        let input_schema = input.schema();

        // Resolve key field
        let key_field_id = match input.schema().index_of(&key.field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("input data does not contain the key field `{}`", &key.field_name))
        };
        let key_field = &input_schema.fields()[key_field_id];
        let key_field_type = key_field.data_type();

        // Resolve field storing the binning minimum
        let min_field_id = match stats_schema.index_of(&key_binning.stats_minimum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("statistics data does not contain the field storing the binning minimum `{}`", &key_binning.stats_minimum_field_name))
        };
        let min_field = &stats_schema.fields()[min_field_id];
        let min_field_type = min_field.data_type();

        // Resolve field storing the binning minimum
        let max_field_id = match stats_schema.index_of(&key_binning.stats_maximum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("statistics data does not contain the field storing the binning minimum `{}`", &key_binning.stats_minimum_field_name))
        };
        let max_field = &stats_schema.fields()[max_field_id];
        let max_field_type = max_field.data_type();

        // Make sure the minimum field has the same type as the key column
        if min_field.data_type() != key_field_type {
            return Err(anyhow::anyhow!("types of key field `{}` and minimum field `{}` do not match: {} != {}", key_field.name(), min_field.name(), key_field_type, min_field_type));
        }
        // Make sure the maximum field has the same type as the key column
        if max_field.data_type() != key_field_type {
            return Err(anyhow::anyhow!("types of key field `{}` and maximum field `{}` do not match: {} != {}", key_field.name(), max_field.name(), key_field_type, max_field_type));
        }
        // Read maximum value
        let max_value = ScalarValue::try_from_array(&stats_batch.columns()[max_field_id], 0)?;
        // Read the minimum value
        let min_value = ScalarValue::try_from_array(&stats_batch.columns()[min_field_id], 0)?;

        // Bin the key field
        let key_binned: BinnedExpression = match &key_field_type {
            DataType::Float16 | DataType::Float32 | DataType::Float64 => {
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Float64)?
                    .div(ScalarValue::Float64(Some(key_binning.bin_count as f64)))?;
                if let ScalarValue::Float64(Some(0.0)) = numeric_bin_width {
                    numeric_bin_width = ScalarValue::Float64(None);
                }
                let key_delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_delta_f64 = Arc::new(CastExpr::new(key_delta, DataType::Float64, None));
                let key_binned = binary(key_delta_f64, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                let floor_udf = floor();
                let key_binned = Arc::new(ScalarFunctionExpr::new(
                    floor_udf.name(),
                    floor_udf.clone(),
                    vec![key_binned],
                    DataType::Float64,
                ));
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value: min_value.clone(),
                    numeric_bin_width,
                    output_type_bin_width: DataType::Float64,
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64
            => {
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::UInt64)?
                    .div(ScalarValue::UInt64(Some(key_binning.bin_count as u64)))?;
                if let ScalarValue::UInt64(Some(0)) = numeric_bin_width {
                    numeric_bin_width = ScalarValue::UInt64(None);
                }
                let key_delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_delta_u64 = Arc::new(CastExpr::new(key_delta, DataType::UInt64, None));
                let key_binned = binary(key_delta_u64, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value: min_value.clone(),
                    numeric_bin_width,
                    output_type_bin_width: DataType::UInt64,
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 
            => {
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(key_binning.bin_count as i64)))?;
                if let ScalarValue::Int64(Some(0)) = numeric_bin_width {
                    numeric_bin_width = ScalarValue::Int64(None);
                }
                let key_delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_delta_i64 = Arc::new(CastExpr::new(key_delta, DataType::Int64, None));
                let key_binned = binary(key_delta_i64, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value: min_value.clone(),
                    numeric_bin_width,
                    output_type_bin_width: DataType::Int64,
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::Timestamp(_, _) => {
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(key_binning.bin_count as i64)))?;
                if numeric_bin_width == ScalarValue::Int64(Some(0)) {
                    numeric_bin_width = ScalarValue::Int64(None);
                }
                let key_delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_delta_i64 = Arc::new(CastExpr::new(key_delta, DataType::Int64, None));
                let key_binned = binary(key_delta_i64, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value: min_value.clone(),
                    numeric_bin_width,
                    output_type_bin_width: DataType::Duration(TimeUnit::Millisecond),
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::Time32(_) => {
                let max_value = max_value.cast_to(&DataType::Int32)?;
                let min_value = min_value.cast_to(&DataType::Int32)?;
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Int32(Some(key_binning.bin_count as i32)))?;
                if numeric_bin_width == ScalarValue::Int32(Some(0)) {
                    numeric_bin_width = ScalarValue::Int32(None);
                }
                let key_field = Arc::new(CastExpr::new(col(key_field.name(), &input.schema())?, DataType::Int32, None));
                let key_delta = binary(key_field, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_binned = binary(key_delta, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value,
                    numeric_bin_width,
                    output_type_bin_width: DataType::Int32,
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::Time64(_) => {
                let max_value = max_value.cast_to(&DataType::Int64)?;
                let min_value = min_value.cast_to(&DataType::Int64)?;
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Int64(Some(key_binning.bin_count as i64)))?;
                if numeric_bin_width == ScalarValue::Int64(Some(0)) {
                    numeric_bin_width = ScalarValue::Int64(None);
                }
                let key_field = Arc::new(CastExpr::new(col(key_field.name(), &input.schema())?, DataType::Int64, None));
                let key_delta = binary(key_field, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_binned = binary(key_delta, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value,
                    numeric_bin_width,
                    output_type_bin_width: DataType::Int64,
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::Date32 | DataType::Date64 => {
                let max_value = max_value.cast_to(&DataType::Timestamp(TimeUnit::Millisecond, None))?;
                let min_value = min_value.cast_to(&DataType::Timestamp(TimeUnit::Millisecond, None))?;
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(key_binning.bin_count as i64)))?;
                if numeric_bin_width == ScalarValue::Int64(Some(0)) {
                    numeric_bin_width = ScalarValue::Int64(None);
                }
                let key_field = Arc::new(CastExpr::new(col(key_field.name(), &input.schema())?, DataType::Timestamp(TimeUnit::Millisecond, None), None));
                let key_delta = binary(key_field, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_delta = Arc::new(CastExpr::new(key_delta, DataType::Int64, None));
                let key_binned = binary(key_delta, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value,
                    numeric_bin_width,
                    output_type_bin_width: DataType::Duration(TimeUnit::Millisecond),
                    output_type_bin_bounds: key_field_type.clone(),
                }
            }

            DataType::Decimal128(precision, scale) => {
                let max_value = max_value.cast_to(&DataType::Decimal256(38, 18))?;
                let min_value = min_value.cast_to(&DataType::Decimal256(38, 18))?;
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Decimal256(Some(i256::from(key_binning.bin_count as i64) * i256::from(10).pow_wrapping(*scale as u32)), *precision, *scale))?;
                if numeric_bin_width == ScalarValue::Decimal256(Some(i256::from(0)), *precision, *scale) {
                    numeric_bin_width = ScalarValue::Decimal256(None, *precision, *scale);
                }
                let key_field = Arc::new(CastExpr::new(col(key_field.name(), &input.schema())?, DataType::Decimal256(38, 18), None));
                let key_delta = binary(key_field, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_binned = binary(key_delta, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                let key_binned = Arc::new(CastExpr::new(key_binned, DataType::Decimal256(38, 0), None));
                let key_binned = Arc::new(CastExpr::new(key_binned, DataType::Decimal256(38, 18), None));
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value: min_value.cast_to(&DataType::Decimal128(38, 18))?,
                    numeric_bin_width,
                    output_type_bin_width: DataType::Decimal128(*precision, *scale),
                    output_type_bin_bounds: DataType::Decimal128(*precision, *scale),
                }
            }

            DataType::Decimal256(precision, scale) => {
                let mut numeric_bin_width = max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Decimal256(Some(i256::from(key_binning.bin_count as i64) * i256::from(10).pow_wrapping(*scale as u32)), *precision, *scale))?;
                if numeric_bin_width == ScalarValue::Decimal256(Some(i256::from(0)), *precision, *scale) {
                    numeric_bin_width = ScalarValue::Decimal256(None, *precision, *scale);
                }
                let key_delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let key_binned = binary(key_delta, Operator::Divide, lit(numeric_bin_width.clone()), &input.schema())?;
                let key_binned = Arc::new(CastExpr::new(key_binned, DataType::Decimal256(38, 0), None));
                let key_binned = Arc::new(CastExpr::new(key_binned, DataType::Decimal256(38, 18), None));
                BinnedExpression {
                    binning_config: key_binning.clone(),
                    binning_expr: Arc::new(CastExpr::new(key_binned, DataType::UInt32, None)),
                    output_alias: key.output_alias.clone(),
                    min_value: min_value.clone(),
                    numeric_bin_width,
                    output_type_bin_width: DataType::Decimal256(*precision, *scale),
                    output_type_bin_bounds: DataType::Decimal256(*precision, *scale),
                }
            }

            _ => return Err(anyhow::anyhow!("key binning is not implemented for data type: {}", key_field_type))
        };
        // Return binned key
        return Ok(key_binned);
    }

    /// Group a data frame
    async fn group_by(&self, config: &GroupByTransform, stats: Option<&DataFrame>, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<Arc<dyn ExecutionPlan>> {
        // Detect collisions among output aliases
        let mut output_field_names: HashSet<&str> = HashSet::new();

        // Collect grouping expressions
        let mut grouping_exprs: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
        let mut binned_exprs: Vec<BinnedExpression> = Vec::new();
        for key in config.keys.iter() {
            // Output name collision?
            if output_field_names.contains(key.output_alias.as_str()) {
                return Err(anyhow::anyhow!("duplicate output name `{}`", key.output_alias.as_str()))
            }
            // Check if any key requires statistics
            let key_expr = if let Some(key_binning) = &key.binning  {
                if let Some(stats) = &stats {
                    let binned = self.compute_bin(key, key_binning, stats, input.clone())?;
                    let binning_expr = binned.binning_expr.clone();
                    binned_exprs.push(binned);
                    binning_expr
                } else {
                    return Err(anyhow::anyhow!("binning for key `{}` requires precomputed statistics, use transformWithStats", key.output_alias.as_str()))
                }
            } else {
                col(&key.field_name, &self.schema)?
            };
            // Create key expression
            grouping_exprs.push((key_expr, key.output_alias.clone()));
            output_field_names.insert(&key.output_alias);
        }

        // Create the grouping
        let mut grouping_set = Vec::new();
        grouping_set.resize(grouping_exprs.len(), false);
        let grouping = PhysicalGroupBy::new(grouping_exprs, Vec::new(), vec![grouping_set]);

        // Collect aggregate expressions
        let mut aggregate_exprs: Vec<AggregateFunctionExpr> = Vec::new();
        for aggr in config.aggregates.iter() {
            // Output name collision?
            if output_field_names.contains(aggr.output_alias.as_str()) {
                return Err(anyhow::anyhow!("duplicate output name `{}`", aggr.output_alias.as_str()))
            }
            // Get aggregation function
            let aggr_func = aggr.aggregation_function.try_into()?;
            // Check proto settings
            match aggr_func {
                AggregationFunction::Min | AggregationFunction::Max | AggregationFunction::Average => {
                    if aggr.aggregate_distinct {
                        return Err(anyhow::anyhow!("function '{}' does not support distinct aggregation", aggr_func.as_str_name()));
                    }
                }
                AggregationFunction::Count | AggregationFunction::CountStar => {
                    if aggr.aggregate_lengths {
                        return Err(anyhow::anyhow!("function '{}' does not support length aggregation", aggr_func.as_str_name()));
                    }
                }
            }
            // The input value
            let mut input_value = col(&aggr.field_name, &input.schema())?;
            let input_schema = input.schema();
            let input_field_id = input_schema.index_of(&aggr.field_name)?;
            let input_field = input_schema.field(input_field_id);
            if aggr.aggregate_lengths {
                match &input_field.data_type() {
                    DataType::List(_) | DataType::FixedSizeList(..) | DataType::LargeList(_) => {
                        let udf = array_length_udf();
                        let udf_expr = ScalarFunctionExpr::new(
                            udf.name(),
                            udf.clone(),
                            vec![input_value],
                            DataType::UInt64,
                        );
                        input_value = Arc::new(udf_expr);
                    },
                    DataType::Utf8 => {
                        let udf = character_length();
                        let udf_expr = ScalarFunctionExpr::new(
                            udf.name(),
                            udf.clone(),
                            vec![input_value],
                            DataType::Int32,
                        );
                        input_value = Arc::new(udf_expr);
                    }
                    DataType::LargeUtf8 => {
                        let udf = character_length();
                        let udf_expr = ScalarFunctionExpr::new(
                            udf.name(),
                            udf.clone(),
                            vec![input_value],
                            DataType::Int64,
                        );
                        input_value = Arc::new(udf_expr);
                    }
                    _ => ()
                }
            }

            // Get the aggregate expression
            let aggr_expr = match aggr.aggregation_function.try_into()? {
                AggregationFunction::Min => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Min::new())),
                        vec![input_value]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Max => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Max::new())),
                        vec![input_value]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Average => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Avg::new())),
                        vec![input_value]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Count => {
                     AggregateExprBuilder::new(count_udaf(), vec![input_value])
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .with_distinct(aggr.aggregate_distinct)
                        .build()?
                },
                AggregationFunction::CountStar => {
                     AggregateExprBuilder::new(count_udaf(), vec![lit(1)])
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .with_distinct(aggr.aggregate_distinct)
                        .build()?
                },
            };
            aggregate_exprs.push(aggr_expr);
        }

        // Construct null expressions
        let mut aggregate_exprs_filters = Vec::new();
        aggregate_exprs_filters.resize(aggregate_exprs.len(), None);

        // Construct the aggregation
        let groupby_exec = AggregateExec::try_new(
            AggregateMode::Single,
            grouping,
            aggregate_exprs,
            aggregate_exprs_filters,
            input.clone(),
            input.schema()
        )?;
        let mut output: Arc<dyn ExecutionPlan> = Arc::new(groupby_exec);

        if !binned_exprs.is_empty() {
            // Copy over all current fields
            let mut fields: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
            for field in output.schema().fields().iter() {
                fields.push((col(&field.name(), &output.schema())?, field.name().clone()));
            }
            // Construct the binning fields
            for binned in binned_exprs.iter() {
                let mut binning_fields = binned.get_output_fields(&output)?;
                fields.append(&mut binning_fields);
            }
            // Construct the projection
            let projection_exec = ProjectionExec::try_new(fields, output)?;
            output = Arc::new(projection_exec);
        }
        return Ok(output);
    }

    /// Transform a data frame
    pub(crate) async fn transform(&self, transform: &DataFrameTransform, stats: Option<&DataFrame>) -> anyhow::Result<DataFrame> {
        let mut input: Arc<dyn ExecutionPlan> = Arc::new(
            MemoryExec::try_new(&self.partitions, self.schema.clone(), None).unwrap(),
        );
        if let Some(group_by) = &transform.group_by {
            input = self.group_by(group_by, stats, input).await?;
        }
        if let Some(order_by) = &transform.order_by {
            input = Arc::new(self.order_by(order_by, input).await?);
        }
        let task_ctx = Arc::new(TaskContext::default());
        let result_schema = input.schema().clone();
        let result_batches = collect(input, task_ctx.clone()).await?;
        Ok(DataFrame::new(result_schema, result_batches))
    }

    /// Transform a data frame
    #[wasm_bindgen(js_name="transform")]
    pub async fn transform_pb(&self, proto: &[u8]) -> Result<DataFrame, JsError> {
        let transform = DataFrameTransform::decode(proto).map_err(|e| JsError::new(&e.to_string()))?;
        self.transform(&transform, None).await.map_err(|e| JsError::new(&e.to_string()))
    }

    /// Transform a data frame with precomputed statistics (for example needed for binning)
    #[wasm_bindgen(js_name="transformWithStats")]
    pub async fn transform_pb_with_stats(&self, proto: &[u8], stats: &DataFrame) -> Result<DataFrame, JsError> {
        let transform = DataFrameTransform::decode(proto).map_err(|e| JsError::new(&e.to_string()))?;
        self.transform(&transform, Some(&stats)).await.map_err(|e| JsError::new(&e.to_string()))
    }
}

struct BinnedExpression {
    binning_config: GroupByKeyBinning,
    binning_expr: Arc<dyn PhysicalExpr>,
    output_alias: String,
    min_value: ScalarValue,
    numeric_bin_width: ScalarValue,
    output_type_bin_width: DataType,
    output_type_bin_bounds: DataType,
}
impl BinnedExpression {
    fn get_output_fields(&self, input: &Arc<dyn ExecutionPlan>) -> anyhow::Result<Vec<(Arc<dyn PhysicalExpr>, String)>> {
        // Compute the bin value
        let bin_value = col(&self.output_alias, &input.schema())?;
        // Cast the bin value to the bin width datatype for offset arithmetics
        let bin_value_casted = Arc::new(CastExpr::new(bin_value, self.numeric_bin_width.data_type(), None));
        // Compute the offset of the lower bound
        let bin_width = lit(self.numeric_bin_width.clone());
        let offset_lb = binary(bin_value_casted.clone(), Operator::Multiply, bin_width.clone(), &input.schema())?;
        // Compute the offset of the upper bound
        let offset_ub = binary(offset_lb.clone(), Operator::Plus, bin_width.clone(), &input.schema())?;
        // Compute bin width
        let bin_width_casted = Arc::new(CastExpr::new(bin_width.clone(), self.output_type_bin_width.clone(), None));
        // Compute lower bound
        let min_value = lit(self.min_value.clone());
        let mut bin_lb_casted = binary(min_value.clone(), Operator::Plus, Arc::new(CastExpr::new(offset_lb.clone(), self.output_type_bin_width.clone(), None)), &input.schema())?;
        bin_lb_casted = Arc::new(CastExpr::new(bin_lb_casted.clone(), self.output_type_bin_bounds.clone(), None));
        // Compute upper bound
        let mut bin_ub_casted = binary(min_value.clone(), Operator::Plus, Arc::new(CastExpr::new(offset_ub.clone(), self.output_type_bin_width.clone(), None)), &input.schema())?;
        bin_ub_casted = Arc::new(CastExpr::new(bin_ub_casted.clone(), self.output_type_bin_bounds.clone(), None));

        Ok(vec![
            (bin_width_casted, self.binning_config.output_bin_width_alias.clone()),
            (bin_lb_casted, self.binning_config.output_bin_lb_alias.clone()),
            (bin_ub_casted, self.binning_config.output_bin_ub_alias.clone()),
        ])
    }
}
