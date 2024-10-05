use std::{collections::HashSet, sync::Arc};

use arrow::array::Array;
use arrow::array::AsArray;
use arrow::array::RecordBatch;
use arrow::datatypes::DataType;
use arrow::datatypes::Int64Type;
use arrow::datatypes::Schema;
use datafusion_common::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_expr::test::function_stub::Avg;
use datafusion_expr::test::function_stub::Max;
use datafusion_expr::test::function_stub::Min;
use datafusion_expr::AggregateUDF;
use datafusion_expr::Operator;
use datafusion_functions_aggregate::count::count_udaf;
use datafusion_physical_expr::aggregate::AggregateExprBuilder;
use datafusion_physical_expr::expressions::binary;
use datafusion_physical_expr::expressions::lit;
use datafusion_physical_expr::expressions::CastExpr;
use datafusion_physical_expr::PhysicalExpr;
use datafusion_physical_expr::PhysicalSortExpr;
use datafusion_physical_expr::aggregate::AggregateFunctionExpr;
use datafusion_physical_expr::expressions::col;
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

/// Get a scalar value
fn read_scalar_value(batch: &RecordBatch, field_id: usize, row_id: usize) -> Result<ScalarValue, JsError> {
    let schema = batch.schema_ref();
    match &schema.fields()[field_id].data_type() {
        DataType::Int64 => {
            let values = batch.column(field_id).as_primitive::<Int64Type>();
            let value = if values.is_nullable() && values.is_null(row_id) {
                ScalarValue::Int64(None)
            } else {
                ScalarValue::Int64(Some(values.value(row_id)))
            };
            Ok(value)
        },
        _ => Err(JsError::new("unsupported min value type"))
    }
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
    async fn order_by(&self, config: &OrderByTransform, input: Arc<dyn ExecutionPlan>) -> Result<SortExec, JsError> {
        let mut sort_exprs: Vec<PhysicalSortExpr> = Vec::new();
        for constraint in config.constraints.iter() {
            let sort_options = arrow::compute::SortOptions {
                descending: !constraint.ascending,
                nulls_first: constraint.nulls_first,
            };
            sort_exprs.push(PhysicalSortExpr {
                expr: col(&constraint.field_name, &self.schema)?,
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
    fn bin_key(&self, key: &GroupByKey, key_binning: &GroupByKeyBinning, stats: &DataFrame, input: Arc<dyn ExecutionPlan>) -> Result<Arc<dyn PhysicalExpr>, JsError> {
        // Unexpected schema for statistics frame?
        if self.partitions.is_empty() || self.partitions[0].is_empty() || self.partitions[0][0].num_rows() != 1 {
            return Err(JsError::new("statistics data must have exactly 1 row"));
        }
        let stats_batch = &stats.partitions[0][0];
        let stats_schema = stats_batch.schema_ref();
        let input_schema = input.schema();

        // Resolve key field
        let key_field_id = match input.schema().index_of(&key.field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(JsError::new(&format!("input data does not contain the key field `{}`", &key.field_name)))
        };
        let key_field = &input_schema.fields()[key_field_id];
        let key_field_type = &key_field.data_type();

        // Resolve field storing the binning minimum
        let min_field_id = match stats_schema.index_of(&key_binning.stats_minimum_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(JsError::new(&format!("statistics data does not contain the field storing the binning minimum `{}`", &key_binning.stats_minimum_field_name)))
        };
        let min_field = &stats_schema.fields()[min_field_id];
        let min_field_type = &min_field.data_type();

        // Resolve field storing the binning width
        let binning_width_field_id = match stats_schema.index_of(&key_binning.stats_bin_width_field_name) {
            Ok(field_id) => field_id,
            Err(_) => return Err(JsError::new(&format!("statistics data does not contain the field storing the binning width `{}`", &key_binning.stats_minimum_field_name)))
        };
        let binning_width_field = &stats_schema.fields()[binning_width_field_id];
        let binning_width_type = binning_width_field.data_type();

        // Make sure the minimum field has the same type as the key column
        if min_field.data_type() != *key_field_type {
            return Err(JsError::new(&format!("types of key field `{}` and minimum field `{}` do not match: {} != {}", key_field.name(), min_field.name(), key_field_type, min_field_type)));
        }

        // Read minimum value
        let min_value = read_scalar_value(stats_batch, min_field_id, 0)?;
        // Read binning width
        let binning_width_value = read_scalar_value(stats_batch, binning_width_field_id, 0)?;
        // Compute difference to minimum
        let delta = binary(col(key_field.name(), &input.schema())?, Operator::Minus, lit(min_value), &input.schema())?;
        // Cast to binning width type
        let delta_casted = Arc::new(CastExpr::new(delta, binning_width_type.clone(), None));
        // Divide by binning width
        // XXX Div by zero
        let binned_key = binary(delta_casted, Operator::Divide, lit(binning_width_value), &input.schema())?;
        // Return binning key
        return Ok(binned_key);
    }

    /// Group a data frame
    async fn group_by(&self, config: &GroupByTransform, stats: Option<&DataFrame>, input: Arc<dyn ExecutionPlan>) -> Result<AggregateExec, JsError> {
        // Detect collisions among output aliases
        let mut output_field_names: HashSet<&str> = HashSet::new();

        // Collect grouping expressions
        let mut grouping_exprs: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
        for key in config.keys.iter() {
            // Key name collision?
            if output_field_names.contains(key.output_alias.as_str()) {
                return Err(JsError::new(&format!("duplicate key name `{}`", key.output_alias.as_str())))
            }
            // Check if any key requires statistics
            let key_expr = if let Some(key_binning) = &key.binning  {
                if let Some(stats) = &stats {
                    self.bin_key(key, key_binning, stats, input.clone())?
                } else {
                    return Err(JsError::new(&format!("binning for key `{}` requires precomputed statistics, use transformWithStats", key.output_alias.as_str())))
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
                        return Err(JsError::new(&format!("function '{}' does not support distinct aggregation", aggr_func.as_str_name())));
                    }
                }
                AggregationFunction::Count | AggregationFunction::CountStar => {
                    if aggr.aggregate_lengths {
                        return Err(JsError::new(&format!("function '{}' does not support length aggregation", aggr_func.as_str_name())));
                    }
                }
            }
            // Get the aggregate expression
            let aggr_expr = match aggr.aggregation_function.try_into()? {
                AggregationFunction::Min => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Min::new())),
                        vec![col(&aggr.field_name, &input.schema())?]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Max => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Max::new())),
                        vec![col(&aggr.field_name, &input.schema())?]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::Average => {
                    AggregateExprBuilder::new(
                        Arc::new(AggregateUDF::new_from_impl(Avg::new())),
                        vec![col(&aggr.field_name, &input.schema())?]
                    )
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .build()?
                },
                AggregationFunction::CountStar => {
                     AggregateExprBuilder::new(count_udaf(), vec![lit(1)])
                        .schema(input.schema())
                        .alias(&aggr.output_alias)
                        .with_distinct(aggr.aggregate_distinct)
                        .build()?
                },
                AggregationFunction::Count => {
                     AggregateExprBuilder::new(count_udaf(), vec![col(&aggr.field_name, &input.schema())?])
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

    async fn transform(&self, transform: &DataFrameTransform, stats: Option<&DataFrame>) -> Result<DataFrame, JsError> {
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
    pub async fn transform_without_stats(&self, proto: &[u8]) -> Result<DataFrame, JsError> {
        let transform = DataFrameTransform::decode(proto)?;
        self.transform(&transform, None).await
    }

    /// Transform a data frame with precomputed statistics (for example needed for binning)
    #[wasm_bindgen(js_name="transformWithStats")]
    pub async fn transform_with_stats(&self, proto: &[u8], stats: &DataFrame) -> Result<DataFrame, JsError> {
        let transform = DataFrameTransform::decode(proto)?;
        self.transform(&transform, Some(&stats)).await
    }
}
