use std::{collections::HashSet, sync::Arc};

use arrow::array::{ArrayRef, ArrowNativeTypeOp, UInt32Array};
use arrow::array::RecordBatch;
use arrow::datatypes::i256;
use arrow::datatypes::DataType;
use arrow::datatypes::Schema;
use arrow::datatypes::SchemaRef;
use arrow::datatypes::TimeUnit;
use datafusion_common::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_expr::{AggregateUDF, WindowFrame};
use datafusion_expr::Operator;
use datafusion_functions::math::floor;
use datafusion_functions_aggregate::average::Avg;
use datafusion_functions_aggregate::count::count_udaf;
use datafusion_functions_aggregate::min_max::Max;
use datafusion_functions_aggregate::min_max::Min;
use datafusion_functions_window::rank::dense_rank_udwf;
use datafusion_functions_window::row_number::row_number_udwf;
use datafusion_physical_expr::expressions::CaseExpr;
use datafusion_physical_expr::window::BuiltInWindowExpr;
use datafusion_physical_expr::{LexOrdering, PhysicalExpr};
use datafusion_physical_expr::PhysicalSortExpr;
use datafusion_physical_expr::aggregate::AggregateExprBuilder;
use datafusion_physical_expr::aggregate::AggregateFunctionExpr;
use datafusion_physical_expr::expressions::CastExpr;
use datafusion_physical_expr::expressions::binary;
use datafusion_physical_expr::expressions::col;
use datafusion_physical_expr::expressions::lit;
use datafusion_physical_expr::ScalarFunctionExpr;
use datafusion_physical_plan::joins::{HashJoinExec, PartitionMode};
use datafusion_physical_plan::projection::ProjectionExec;
use datafusion_physical_plan::windows::BoundedWindowAggExec;
use datafusion_physical_plan::{ExecutionPlan, InputOrderMode, WindowExpr};
use datafusion_physical_plan::aggregates::{AggregateMode, AggregateExec, PhysicalGroupBy};
use datafusion_physical_plan::collect;
use datafusion_physical_plan::memory::MemoryExec;
use datafusion_physical_plan::sorts::sort::SortExec;
use prost::Message;
use wasm_bindgen::prelude::*;

use crate::arrow_out::DataFrameIpcStream;
use crate::proto::sqlynx_compute::{AggregationFunction, BinningTransform, DataFrameTransform, GroupByKeyBinning, GroupByTransform, OrderByTransform, ValueIdentifierTransform, RowNumberTransform};
use crate::udwf::create_udwf_window_expr;

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
    fn order_by(&self, config: &OrderByTransform, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<SortExec> {
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
            LexOrdering::new(sort_exprs),
            input,
        ).with_fetch(sort_limit);
        return Ok(sort_exec);
    }

    /// Compute a row number
    fn row_number(&self, row_num: &RowNumberTransform, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<Arc<dyn ExecutionPlan>> {
        // Create udwf expression
        let udwf_expr = create_udwf_window_expr(
            &row_number_udwf(),
            &[],
            &input.schema(),
            row_num.output_alias.clone(),
            false)?;
        // Create window frame
        let frame = Arc::new(WindowFrame::new(None));
        // Create the window expression
        let window_expr: Arc<dyn WindowExpr> = Arc::new(BuiltInWindowExpr::new(udwf_expr, &[], &[], frame));
        // Create the window aggregate
        let window_agg = BoundedWindowAggExec::try_new(vec![window_expr], input, vec![], InputOrderMode::Linear)?;
        // Use the window aggregate as new input
        Ok(Arc::new(window_agg))
    }

    /// Rank by a field
    fn value_identifiers(&self, ids: &[ValueIdentifierTransform], mut input: Arc<dyn ExecutionPlan>) -> anyhow::Result<Arc<dyn ExecutionPlan>> {
        for ranking in ids.iter() {
            // Sort by the ranking column 
            let input_col = col(&ranking.field_name, &input.schema())?;
            let sort_exprs: Vec<PhysicalSortExpr> = vec![
                PhysicalSortExpr {
                    expr: input_col.clone(),
                    options: arrow::compute::SortOptions {
                        descending: false,
                        nulls_first: false
                    },
                }
            ];
            // Create the sort operator
            let sort_exec = Arc::new(SortExec::new(
                LexOrdering::new(sort_exprs),
                input,
            ));
            // Create udwf expression
            let udwf_expr = create_udwf_window_expr(
                &dense_rank_udwf(),
                &[input_col],
                &sort_exec.schema(),
                ranking.output_alias.clone(),
                false)?;

            // Create window frame
            let frame = Arc::new(WindowFrame::new(Some(true)));
            // Create the window expression
            let window_expr: Arc<dyn WindowExpr> = Arc::new(BuiltInWindowExpr::new(udwf_expr, &[], sort_exec.expr(), frame));
            // Create the window aggregate
            let window_agg = BoundedWindowAggExec::try_new(vec![window_expr], sort_exec, vec![], InputOrderMode::Linear)?;
            // Use the window aggregate as new input
            input = Arc::new(window_agg);
        }
        Ok(input)
    }

    // Pre-bin fields
    fn bin_fields(&self, bin_fields: &[BinningTransform], stats: &DataFrame, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<Arc<dyn ExecutionPlan>> {
        let mut fields: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
        for field in input.schema().fields().iter() {
            fields.push((col(&field.name(), &input.schema())?, field.name().clone()));
        }
        for binning in bin_fields.iter() {
            let (fractional_bin, _binning_metadata) = self.bin_field(&binning.field_name, binning.bin_count, stats, &binning.stats_minimum_field_name, &binning.stats_maximum_field_name, &input)?;
            fields.push((fractional_bin, binning.output_alias.clone()));
        }

        // Construct the projection
        let projection_exec = ProjectionExec::try_new(fields, input)?;
        let output: Arc<dyn ExecutionPlan> = Arc::new(projection_exec);
        return Ok(output);
    }

    /// Bin a field value
    fn bin_field(&self, field_name: &str, mut bin_count: u32, stats: &DataFrame, stats_minimum_field_name: &str, stats_maximum_field_name: &str, input: &Arc<dyn ExecutionPlan>) -> anyhow::Result<(Arc<dyn PhysicalExpr>, BinningMetadata)> {
        // Unexpected schema for statistics frame?
        if stats.partitions.is_empty() || stats.partitions[0].is_empty() || stats.partitions[0][0].num_rows() != 1 {
            return Err(anyhow::anyhow!("statistics data must have exactly 1 row"));
        }
        bin_count = bin_count.max(1);
        let stats_batch = &stats.partitions[0][0];
        let stats_schema = stats_batch.schema_ref();
        let input_schema = input.schema();

        // Resolve key field
        let value_field_id = match input.schema().index_of(field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("input data does not contain the key field `{}`", field_name))
        };
        let value_field = &input_schema.fields()[value_field_id];
        let value_type = value_field.data_type().clone();
        let value = col(value_field.name(), &input.schema())?;

        // Resolve field storing the binning minimum
        let min_field_id = match stats_schema.index_of(&stats_minimum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("statistics data does not contain the field storing the binning minimum `{}`", &stats_minimum_field_name))
        };
        let min_field = &stats_schema.fields()[min_field_id];
        let min_field_type = min_field.data_type();

        // Resolve field storing the binning minimum
        let max_field_id = match stats_schema.index_of(&stats_maximum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(anyhow::anyhow!("statistics data does not contain the field storing the binning minimum `{}`", &stats_minimum_field_name))
        };
        let max_field = &stats_schema.fields()[max_field_id];
        let max_field_type = max_field.data_type();

        // Make sure the minimum field has the same type as the key column
        if min_field.data_type() != &value_type {
            return Err(anyhow::anyhow!("types of key field `{}` and minimum field `{}` do not match: {} != {}", value_field.name(), min_field.name(), value_type, min_field_type));
        }
        // Make sure the maximum field has the same type as the key column
        if max_field.data_type() != &value_type {
            return Err(anyhow::anyhow!("types of key field `{}` and maximum field `{}` do not match: {} != {}", value_field.name(), max_field.name(), value_type, max_field_type));
        }
        // Read maximum value
        let max_value = ScalarValue::try_from_array(&stats_batch.columns()[max_field_id], 0)?;
        // Read the minimum value
        let min_value = ScalarValue::try_from_array(&stats_batch.columns()[min_field_id], 0)?;

        // Bin the key field
        let (bin_f64, binning_metadata): (Arc<dyn PhysicalExpr>, BinningMetadata) = match &value_type {
            DataType::Float16 | DataType::Float32 | DataType::Float64 => {
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Float64)? 
                    .div(ScalarValue::Float64(Some(bin_count as f64)))?
                {
                    ScalarValue::Float64(Some(0.0)) => ScalarValue::Float64(Some(1.0)),
                    ScalarValue::Float64(Some(v)) => ScalarValue::Float64(Some(v.abs())),
                    ScalarValue::Float64(None) => ScalarValue::Float64(None),
                    _ => unreachable!(),
                };

                // Compute fractional bin
                let min_delta = binary(value.clone(), Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let min_offset = Arc::new(CastExpr::new(min_delta, DataType::Float64, None));
                let bin_f64 = binary(min_offset, Operator::Divide, lit(bin_width.clone()), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Float64,
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::UInt8 | DataType::UInt16 | DataType::UInt32 | DataType::UInt64
            => {
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::UInt64)?
                    .div(ScalarValue::UInt64(Some(bin_count as u64)))?
                {
                    ScalarValue::UInt64(Some(0)) => ScalarValue::UInt64(Some(1)),
                    ScalarValue::UInt64(Some(v)) => ScalarValue::UInt64(Some(v)),
                    ScalarValue::UInt64(None) => ScalarValue::UInt64(None),
                    _ => unreachable!(),
                };

                // Compute fractional bin
                let min_delta = binary(value.clone(), Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let bin_f64 = binary(
                    Arc::new(CastExpr::new(min_delta, DataType::Float64, None)),
                    Operator::Divide,
                    lit(bin_width.cast_to(&DataType::Float64)?), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::UInt64,
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 
            => {
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(bin_count as i64)))?
                {
                    ScalarValue::Int64(Some(0)) => ScalarValue::Int64(Some(1)),
                    ScalarValue::Int64(Some(v)) => ScalarValue::Int64(Some(v.abs())),
                    ScalarValue::Int64(None) => ScalarValue::Int64(None),
                    _ => unreachable!(),
                };

                // Compute fractional bin
                let min_delta = binary(value.clone(), Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let bin_f64 = binary(
                    Arc::new(CastExpr::new(min_delta, DataType::Float64, None)),
                    Operator::Divide,
                    lit(bin_width.cast_to(&DataType::Float64)?), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Int64,
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::Timestamp(_, _) => {
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(bin_count as i64)))?
                {
                    ScalarValue::Int64(Some(0)) => ScalarValue::Int64(Some(1)),
                    ScalarValue::Int64(Some(v)) => ScalarValue::Int64(Some(v.abs())),
                    ScalarValue::Int64(None) => ScalarValue::Int64(None),
                    _ => unreachable!(),
                };

                // Compute bin
                let min_delta = binary(value.clone(), Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let min_delta = Arc::new(CastExpr::new(min_delta, DataType::Int64, None));
                let bin_f64 = binary(
                    Arc::new(CastExpr::new(min_delta, DataType::Float64, None)),
                    Operator::Divide,
                    lit(bin_width.cast_to(&DataType::Float64)?), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Duration(TimeUnit::Millisecond),
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::Time32(_) => {
                let max_value = max_value.cast_to(&DataType::Int32)?;
                let min_value = min_value.cast_to(&DataType::Int32)?;
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Int32(Some(bin_count as i32)))?
                {
                    ScalarValue::Int32(Some(0)) => ScalarValue::Int32(Some(1)),
                    ScalarValue::Int32(Some(v)) => ScalarValue::Int32(Some(v.abs())),
                    ScalarValue::Int32(None) => ScalarValue::Int32(None),
                    _ => unreachable!(),
                };

                // Compute bin
                let value = Arc::new(CastExpr::new(value.clone(), DataType::Int32, None));
                let min_delta = binary(value, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let bin_f64 = binary(
                    Arc::new(CastExpr::new(min_delta, DataType::Float64, None)),
                    Operator::Divide,
                    lit(bin_width.cast_to(&DataType::Float64)?), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Int32,
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::Time64(_) => {
                let max_value = max_value.cast_to(&DataType::Int64)?;
                let min_value = min_value.cast_to(&DataType::Int64)?;
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Int64(Some(bin_count as i64)))?
                {
                    ScalarValue::Int64(Some(0)) => ScalarValue::Int64(Some(1)),
                    ScalarValue::Int64(Some(v)) => ScalarValue::Int64(Some(v.abs())),
                    ScalarValue::Int64(None) => ScalarValue::Int64(None),
                    _ => unreachable!(),
                };

                // Compute bin
                let value = Arc::new(CastExpr::new(value.clone(), DataType::Int64, None));
                let min_delta = binary(value, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let bin_f64 = binary(
                    Arc::new(CastExpr::new(min_delta, DataType::Float64, None)),
                    Operator::Divide,
                    lit(bin_width.cast_to(&DataType::Float64)?), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Int64,
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::Date32 | DataType::Date64 => {
                let max_value = max_value.cast_to(&DataType::Timestamp(TimeUnit::Millisecond, None))?;
                let min_value = min_value.cast_to(&DataType::Timestamp(TimeUnit::Millisecond, None))?;
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .cast_to(&DataType::Int64)?
                    .div(ScalarValue::Int64(Some(bin_count as i64)))?
                {
                    ScalarValue::Int64(Some(0)) => ScalarValue::Int64(Some(1)),
                    ScalarValue::Int64(Some(v)) => ScalarValue::Int64(Some(v.abs())),
                    ScalarValue::Int64(None) => ScalarValue::Int64(None),
                    _ => unreachable!(),
                };

                // Compute bin
                let value = Arc::new(CastExpr::new(value.clone(), DataType::Timestamp(TimeUnit::Millisecond, None), None));
                let min_delta = binary(value, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let min_delta = Arc::new(CastExpr::new(min_delta, DataType::Int64, None));
                let bin_f64 = binary(
                    Arc::new(CastExpr::new(min_delta, DataType::Float64, None)),
                    Operator::Divide,
                    lit(bin_width.cast_to(&DataType::Float64)?), &input.schema())?;

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Duration(TimeUnit::Millisecond),
                    cast_bin_bounds_type: value_type.clone(),
                })
            }

            DataType::Decimal128(precision, scale) => {
                let max_value = max_value.cast_to(&DataType::Decimal256(*precision, *scale))?;
                let min_value = min_value.cast_to(&DataType::Decimal256(*precision, *scale))?;
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Decimal256(Some(i256::from(bin_count as i64) * i256::from(10).pow_wrapping(*scale as u32)), *precision, *scale))?
                {
                    ScalarValue::Decimal256(Some(i256::ZERO), p, s) => ScalarValue::Decimal256(Some(i256::ONE), p, s),
                    ScalarValue::Decimal256(Some(v), p, s) => ScalarValue::Decimal256(Some(v.wrapping_abs()), p, s),
                    ScalarValue::Decimal256(None, p, s) => ScalarValue::Decimal256(None, p, s),
                    _ => unreachable!(),
                };

                // Compute bin
                let value_d256 = Arc::new(CastExpr::new(value.clone(), DataType::Decimal256(*precision, *scale), None));
                let min_delta = binary(value_d256, Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let bin_d256 = binary(min_delta, Operator::Divide, lit(bin_width.clone()), &input.schema())?;

                // XXX Downcasting to 128bit is necessary as the (d256 -> f64) seems missing
                let bin_d128: Arc<dyn PhysicalExpr> = Arc::new(CastExpr::new(bin_d256.clone(), DataType::Decimal128(*precision, *scale), None));
                let bin_f64: Arc<dyn PhysicalExpr> = Arc::new(CastExpr::new(bin_d128.clone(), DataType::Float64, None));

                (bin_f64, BinningMetadata {
                    min_value: min_value.cast_to(&DataType::Decimal128(*precision, *scale))?,
                    bin_width,
                    cast_bin_width_type: DataType::Decimal128(*precision, *scale),
                    cast_bin_bounds_type: DataType::Decimal128(*precision, *scale),
                })
            }

            DataType::Decimal256(precision, scale) => {
                let bin_width = match max_value
                    .sub(min_value.clone())?
                    .div(ScalarValue::Decimal256(Some(i256::from(bin_count as i64) * i256::from(10).pow_wrapping(*scale as u32)), *precision, *scale))?
                {
                    ScalarValue::Decimal256(Some(i256::ZERO), p, s) => ScalarValue::Decimal256(Some(i256::ONE), p, s),
                    ScalarValue::Decimal256(Some(v), p, s) => ScalarValue::Decimal256(Some(v.wrapping_abs()), p, s),
                    ScalarValue::Decimal256(None, p, s) => ScalarValue::Decimal256(None, p, s),
                    _ => unreachable!(),
                };

                // Compute bin
                let min_delta = binary(value.clone(), Operator::Minus, lit(min_value.clone()), &input.schema())?;
                let bin_d256 = binary(min_delta, Operator::Divide, lit(bin_width.clone()), &input.schema())?;

                // XXX Downcasting to 128bit is necessary as the (d256 -> f64) seems missing
                let bin_d128: Arc<dyn PhysicalExpr> = Arc::new(CastExpr::new(bin_d256.clone(), DataType::Decimal128(*precision, *scale), None));
                let bin_f64: Arc<dyn PhysicalExpr> = Arc::new(CastExpr::new(bin_d128.clone(), DataType::Float64, None));

                (bin_f64, BinningMetadata {
                    min_value,
                    bin_width,
                    cast_bin_width_type: DataType::Decimal256(*precision, *scale),
                    cast_bin_bounds_type: DataType::Decimal256(*precision, *scale),
                })
            }

            _ => return Err(anyhow::anyhow!("key binning is not implemented for data type: {}", value_type))
        };
        // Return binned key
        return Ok((bin_f64, binning_metadata));
    }

    /// Group a data frame
    fn group_by<'a>(&self, config: &'a GroupByTransform, stats: Option<&DataFrame>, input: Arc<dyn ExecutionPlan>) -> anyhow::Result<Arc<dyn ExecutionPlan>> {
        // Detect collisions among output aliases
        let mut output_field_names: HashSet<&str> = HashSet::new();

        // Collect grouping expressions
        let mut grouping_exprs: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
        let mut binned_groups: Vec<(&'a str, &'a GroupByKeyBinning, BinningMetadata)> = Vec::new();
        for key in config.keys.iter() {
            // Output name collision?
            if output_field_names.contains(key.output_alias.as_str()) {
                return Err(anyhow::anyhow!("duplicate output name `{}`", key.output_alias.as_str()))
            }
            // Get the key field
            // Check if we should emit any binning metadata
            let key_expr: Arc<dyn PhysicalExpr> = if let Some(binning) = &key.binning  {
                if !binned_groups.is_empty() {
                    return Err(anyhow::anyhow!("cannot bin more than one key"));
                }
                if let Some(stats) = &stats {
                    // Compute the bin
                    let (bin_f64, binning_metadata) = self.bin_field(&key.field_name, binning.bin_count, stats, &binning.stats_minimum_field_name, &binning.stats_maximum_field_name, &input)?;

                    // Has the field already been explicitly binned?
                    // Then we just ignore the fractional bin expression and use the precomputed field.
                    // This allows the application to materialize the fractional bin value and filter tables on the main thread directly.
                    let bin_f64 = if let Some(pre_binned_name) = &binning.pre_binned_field_name {
                        // Check if pre-binned field exists
                        let input_schema = &input.schema();
                        let pre_binned_field_id = match input_schema.index_of(&pre_binned_name) {
                            Ok(field_id) => field_id,
                            Err(_) => return Err(anyhow::anyhow!("input does not contain the pre-computed bin field `{}`", &pre_binned_name))
                        };
                        // Make sure pre-binned field is a uint32
                        let pre_binned_field = &input_schema.field(pre_binned_field_id);
                        if pre_binned_field.data_type() != &DataType::Float64 {
                            return Err(anyhow::anyhow!("input contains a pre-computed bin field `{}`, but with wrong type: {} != {}", &pre_binned_name, pre_binned_field.data_type(), &DataType::UInt32))
                        }
                        // Seems ok, return column ref
                        col(&pre_binned_name, &self.schema)?
                    } else {
                        bin_f64
                    };

                    // Floor the fractional bin
                    let floor_udf = floor();
                    let bin_f64_floored = Arc::new(ScalarFunctionExpr::new(
                        floor_udf.name(),
                        floor_udf.clone(),
                        vec![bin_f64.clone()],
                        DataType::Float64,
                    ));
                    let bin_u32 = Arc::new(CastExpr::new(bin_f64_floored, DataType::UInt32, None));
                    let bin_key = Arc::new(clamp_bin(bin_u32, binning.bin_count, input.schema())?);

                    // Remember that the key is binned
                    binned_groups.push((&key.output_alias, binning, binning_metadata));
                    // Return the key expression
                    bin_key
                } else {
                    return Err(anyhow::anyhow!("binning for key `{}` requires precomputed statistics, use transformWithStats", key.output_alias.as_str()))
                }
            } else {
                col(&key.field_name, &self.schema)?
            };
            // Create key expression
            grouping_exprs.push((key_expr, key.output_alias.to_string()));
            output_field_names.insert(&key.output_alias);
        }

        // Create the group operator
        let mut grouping_set = Vec::new();
        grouping_set.resize(grouping_exprs.len(), false);
        let grouping = PhysicalGroupBy::new(grouping_exprs, Vec::new(), vec![grouping_set]);

        // Collect aggregate expressions
        let mut aggregate_exprs: Vec<Arc<AggregateFunctionExpr>> = Vec::new();
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
                    if aggr.aggregate_distinct.unwrap_or_default() {
                        return Err(anyhow::anyhow!("function '{}' does not support distinct aggregation", aggr_func.as_str_name()));
                    }
                }
                AggregationFunction::Count | AggregationFunction::CountStar => {}
            }
            // The input value
            let aggr_field_name = match &aggr.field_name {
                Some(n) => n.as_str(),
                None => ""
            };

            // Get the aggregate expression
            let aggr_expr = match aggr.aggregation_function.try_into()? {
                AggregationFunction::Min => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Min::new())),
                        vec![col(&aggr_field_name, &input.schema())?]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Max => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Max::new())),
                        vec![col(&aggr_field_name, &input.schema())?]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Average => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Avg::new())),
                        vec![col(&aggr_field_name, &input.schema())?]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Count => {
                     AggregateExprBuilder::new(count_udaf(), vec![col(&aggr_field_name, &input.schema())?])
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .with_distinct(aggr.aggregate_distinct.unwrap_or_default())
                        .build()?
                },
                AggregationFunction::CountStar => {
                     AggregateExprBuilder::new(count_udaf(), vec![lit(1)])
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .with_distinct(aggr.aggregate_distinct.unwrap_or_default())
                        .build()?
                },
            };
            aggregate_exprs.push(Arc::new(aggr_expr));
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

        // Are there any binned groups?
        // Then we compute additional metadata fields after grouping
        if !binned_groups.is_empty() {
            assert_eq!(binned_groups.len(), 1);
            let (bin_field_name, key_binning, binned_metadata) = &binned_groups[0];

            // Left join all bin keys in the range
            output = create_missing_bins(&output, bin_field_name, key_binning.bin_count)?;

            // Construct the binning fields
            let mut binning_fields = binned_metadata.compute_group_metadata_fields(bin_field_name, key_binning, &output)?;

            // Copy over all current fields
            let mut fields: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
            for field in output.schema().fields().iter() {
                fields.push((col(&field.name(), &output.schema())?, field.name().clone()));
            }
            fields.append(&mut binning_fields);

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
        // Compute the row number
        if let Some(row_number) = &transform.row_number {
            input = self.row_number(&row_number, input)?;
        }
        // Compute the value identifiers
        if !transform.value_identifiers.is_empty() {
            input = self.value_identifiers(&transform.value_identifiers, input)?;
        }
        // Compute the binnings
        if !transform.binning.is_empty() {
            if let Some(stats) = stats {
                input = self.bin_fields(&transform.binning, stats, input)?;
            } else {
                return Err(anyhow::anyhow!("field binning requires precomputed statistics, use transformWithStats"));
            }
        }
        // Compute the groupings
        if let Some(group_by) = &transform.group_by {
            input = self.group_by(group_by, stats, input)?;
        }
        // Order the table (/ topk)
        if let Some(order_by) = &transform.order_by {
            input = Arc::new(self.order_by(order_by, input)?);
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

// Clamp the u32 bin value of the upper bound.
// We currently determine the bin width as ((max - min) / bin_count).
// This means we either need to include the lower or upper bound in the first or last bin if we don't want to have a 1 element bin.
fn clamp_bin(bin: Arc<dyn PhysicalExpr>, bin_count: u32, schema: SchemaRef) -> anyhow::Result<CaseExpr> {
    assert_ne!(bin_count, 0);
    Ok(CaseExpr::try_new(
        None,
        vec![(
            binary(bin.clone(), Operator::GtEq, lit(ScalarValue::UInt32(Some(bin_count as u32))), &schema)?,
            lit(ScalarValue::UInt32(Some(bin_count as u32 - 1)))
        )],
        Some(bin)
    )?)
}

struct BinningMetadata {
    min_value: ScalarValue,
    bin_width: ScalarValue,
    cast_bin_width_type: DataType,
    cast_bin_bounds_type: DataType,
}

impl BinningMetadata {
    /// When grouping by a binned key, we support creating additional metadata fields AFTER grouping.
    /// That way, the application does not need to worry about lower/upper bounds and widths.
    fn compute_group_metadata_fields(&self, key_field_name: &str, key_binning: &GroupByKeyBinning, input: &Arc<dyn ExecutionPlan>) -> anyhow::Result<Vec<(Arc<dyn PhysicalExpr>, String)>> {
        // Compute the bin value
        let bin_value = col(key_field_name, &input.schema())?;
        // Cast the bin value to the bin width datatype for offset arithmetics
        let bin_value_casted = Arc::new(CastExpr::new(bin_value, self.bin_width.data_type(), None));
        // Compute the offset of the lower bound
        let bin_width = lit(self.bin_width.clone());
        let offset_lb = binary(bin_value_casted.clone(), Operator::Multiply, bin_width.clone(), &input.schema())?;
        // Compute the offset of the upper bound
        let offset_ub = binary(offset_lb.clone(), Operator::Plus, bin_width.clone(), &input.schema())?;
        // Compute bin width
        let bin_width_casted = Arc::new(CastExpr::new(bin_width.clone(), self.cast_bin_width_type.clone(), None));
        // Compute lower bound
        let min_value = lit(self.min_value.clone());
        let mut bin_lb_casted = binary(min_value.clone(), Operator::Plus, Arc::new(CastExpr::new(offset_lb.clone(), self.cast_bin_width_type.clone(), None)), &input.schema())?;
        bin_lb_casted = Arc::new(CastExpr::new(bin_lb_casted.clone(), self.cast_bin_bounds_type.clone(), None));
        // Compute upper bound
        let mut bin_ub_casted = binary(min_value.clone(), Operator::Plus, Arc::new(CastExpr::new(offset_ub.clone(), self.cast_bin_width_type.clone(), None)), &input.schema())?;
        bin_ub_casted = Arc::new(CastExpr::new(bin_ub_casted.clone(), self.cast_bin_bounds_type.clone(), None));

        Ok(vec![
            (bin_width_casted, key_binning.output_bin_width_alias.clone()),
            (bin_lb_casted, key_binning.output_bin_lb_alias.clone()),
            (bin_ub_casted, key_binning.output_bin_ub_alias.clone()),
        ])
    }
}

fn create_missing_bins(input: &Arc<dyn ExecutionPlan>, bin_field: &str, bin_count: u32) -> anyhow::Result<Arc<dyn ExecutionPlan>> {
    let all_bins = RecordBatch::try_from_iter(vec![
        (bin_field, Arc::new(UInt32Array::from((0..bin_count).collect::<Vec<u32>>())) as ArrayRef),
    ])?;
    let scan_all_bins = Arc::new(
        MemoryExec::try_new(&[vec![all_bins.clone()]], all_bins.schema(), None)?,
    );
    let mut join_projection: Vec<usize> = vec![0];
    join_projection.reserve(input.schema().fields().len());
    for i in 2..=input.schema().fields().len() {
        join_projection.push(i);
    }
    let join = HashJoinExec::try_new(scan_all_bins.clone(), input.clone(), vec![(
        col(bin_field, &scan_all_bins.schema())?,
        col(bin_field, &input.schema())?
    )], None, &datafusion_expr::JoinType::Left, Some(join_projection), PartitionMode::CollectLeft, false)?;
    let output: Arc<dyn ExecutionPlan> = Arc::new(join);
    Ok(output)
}
