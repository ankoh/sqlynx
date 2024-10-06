use std::{collections::HashSet, sync::Arc};

use arrow::array::ArrowNativeTypeOp;
use arrow::array::RecordBatch;
use arrow::datatypes::i256;
use arrow::datatypes::DataType;
use arrow::datatypes::Schema;
use datafusion_common::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_expr::AggregateUDF;
use datafusion_expr::Operator;
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
    fn compute_binned_key(&self, key: &GroupByKey, key_binning: &GroupByKeyBinning, stats: &DataFrame, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<Arc<dyn PhysicalExpr>> {
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
        let key_field_type = &key_field.data_type();

        // Resolve field storing the binning minimum
        let min_field_id = match stats_schema.index_of(&key_binning.stats_minimum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("statistics data does not contain the field storing the binning minimum `{}`", &key_binning.stats_minimum_field_name))
        };
        let min_field = &stats_schema.fields()[min_field_id];
        let min_field_type = &min_field.data_type();

        // Resolve field storing the binning minimum
        let max_field_id = match stats_schema.index_of(&key_binning.stats_maximum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("statistics data does not contain the field storing the binning minimum `{}`", &key_binning.stats_minimum_field_name))
        };
        let max_field = &stats_schema.fields()[max_field_id];
        let max_field_type = &max_field.data_type();

        // Make sure the minimum field has the same type as the key column
        if min_field.data_type() != *key_field_type {
            return Err(anyhow::anyhow!("types of key field `{}` and minimum field `{}` do not match: {} != {}", key_field.name(), min_field.name(), key_field_type, min_field_type));
        }
        // Make sure the maximum field has the same type as the key column
        if max_field.data_type() != *key_field_type {
            return Err(anyhow::anyhow!("types of key field `{}` and maximum field `{}` do not match: {} != {}", key_field.name(), max_field.name(), key_field_type, max_field_type));
        }
        // Read maximum value
        let max_value = ScalarValue::try_from_array(&stats_batch.columns()[max_field_id], 0)?;
        // Read the minimum value
        let min_value = ScalarValue::try_from_array(&stats_batch.columns()[min_field_id], 0)?;

        // Compute the key difference to minimum
        let key_delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value.clone()), &input.schema())?;
        // Bin the key field
        let key_binned: Arc<dyn PhysicalExpr> = match key_field_type {
            DataType::Float16 | DataType::Float32 | DataType::Float64 => {
                let mut bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Float64)?
                    .div(ScalarValue::Float64(Some(key_binning.bin_count as f64)))?;
                if let ScalarValue::Float64(Some(0.0)) = bin_width {
                    bin_width = ScalarValue::Float64(None);
                }
                let key_delta_casted = Arc::new(CastExpr::new(key_delta, DataType::Float64, None));
                let key_binned = binary(key_delta_casted, Operator::Divide, lit(bin_width), &input.schema())?;
                Arc::new(CastExpr::new(key_binned, DataType::UInt32, None))
            },
            DataType::UInt8
                | DataType::UInt16
                | DataType::UInt32
                | DataType::UInt64
            => {
                let mut bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::UInt64)?
                    .div(ScalarValue::UInt64(Some(key_binning.bin_count as u64)))?;
                if let ScalarValue::UInt64(Some(0)) = bin_width {
                    bin_width = ScalarValue::UInt64(None);
                }
                let key_delta_casted = Arc::new(CastExpr::new(key_delta, DataType::UInt64, None));
                let key_binned = binary(key_delta_casted, Operator::Divide, lit(bin_width), &input.schema())?;
                Arc::new(CastExpr::new(key_binned, DataType::UInt32, None))
            },
            DataType::Int8
                | DataType::Int16
                | DataType::Int32
                | DataType::Int64 
                | DataType::Date32
                | DataType::Date64
                | DataType::Time32(_)
                | DataType::Time64(_)
                | DataType::Timestamp(_, _)
            => {
                let mut bin_width = max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(key_binning.bin_count as i64)))?;
                if let ScalarValue::Int64(Some(0)) = bin_width {
                    bin_width = ScalarValue::Int64(None);
                }
                let key_delta_casted = Arc::new(CastExpr::new(key_delta, DataType::Int64, None));
                let key_binned = binary(key_delta_casted, Operator::Divide, lit(bin_width), &input.schema())?;
                Arc::new(CastExpr::new(key_binned, DataType::Int32, None))
            },
            DataType::Decimal128(precision, scale) => {
                let mut bin_width = max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Decimal128(Some(2 * 10_i128.pow(*scale as u32)), *precision, *scale))?;
                if bin_width == ScalarValue::Decimal128(Some(0), *precision, *scale) {
                    bin_width = ScalarValue::Decimal128(None, *precision, *scale);
                }
                let key_binned = binary(key_delta, Operator::Divide, lit(bin_width), &input.schema())?;
                Arc::new(CastExpr::new(key_binned, DataType::Int32, None))
            },
            DataType::Decimal256(precision, scale) => {
                let mut bin_width = max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Decimal256(Some(i256::from(2) * i256::from(10).pow_wrapping(*scale as u32)), *precision, *scale))?;
                if bin_width == ScalarValue::Decimal256(Some(i256::from(0)), *precision, *scale) {
                    bin_width = ScalarValue::Decimal256(None, *precision, *scale);
                }
                let key_binned = binary(key_delta, Operator::Divide, lit(bin_width), &input.schema())?;
                Arc::new(CastExpr::new(key_binned, DataType::Int32, None))
            },
            _ => return Err(anyhow::anyhow!("key binning is not implemented for data type: {}", key_field_type))
        };
        // Return binned key
        return Ok(key_binned);
    }

    /// Group a data frame
    async fn group_by(&self, config: &GroupByTransform, stats: Option<&DataFrame>, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<AggregateExec> {
        // Detect collisions among output aliases
        let mut output_field_names: HashSet<&str> = HashSet::new();

        // Collect grouping expressions
        let mut grouping_exprs: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
        for key in config.keys.iter() {
            // Key name collision?
            if output_field_names.contains(key.output_alias.as_str()) {
                return Err(anyhow::anyhow!("duplicate key name `{}`", key.output_alias.as_str()))
            }
            // Check if any key requires statistics
            let key_expr = if let Some(key_binning) = &key.binning  {
                if let Some(stats) = &stats {
                    self.compute_binned_key(key, key_binning, stats, input.clone())?
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
        return Ok(groupby_exec);
    }

    /// Transform a data frame
    pub(crate) async fn transform(&self, transform: &DataFrameTransform, stats: Option<&DataFrame>) -> anyhow::Result<DataFrame> {
        let mut input: Arc<dyn ExecutionPlan> = Arc::new(
            MemoryExec::try_new(&self.partitions, self.schema.clone(), None).unwrap(),
        );
        if let Some(group_by) = &transform.group_by {
            input = Arc::new(self.group_by(group_by, stats, input).await?);
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
