use std::{collections::HashSet, sync::Arc};

use arrow::array::RecordBatch;
use arrow::datatypes::Schema;
use datafusion_execution::TaskContext;
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

use crate::{arrow_out::DataFrameIpcStream, proto::sqlynx_compute::{DataFrameTransform, GroupByTransform, OrderByTransform}};

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

    /// Reorder the frame by a single column
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

    async fn group_by(&self, config: &GroupByTransform, stats: Option<&DataFrame>, input: Arc<dyn ExecutionPlan>) -> Result<AggregateExec, JsError> {
        // Detect collisions among output aliases
        let mut output_field_names: HashSet<&str> = HashSet::new();

        let mut grouping_exprs: Vec<(Arc<dyn PhysicalExpr>, String)> = Vec::new();
        for key in config.keys.iter() {
            // Key name collision?
            if output_field_names.contains(key.output_alias.as_str()) {
                return Err(JsError::new("duplicate key names"))
            }
            // Check if any key requires statistics
            if let Some(_binning) = &key.binning  {
                if let Some(_stats) = &stats {
                    // Bin the key column
                } else {
                    return Err(JsError::new("key binning requires precomputed statistics, use transformWithStats"))
                }
            } else {
                grouping_exprs.push((col(&key.field_name, &self.schema)?, key.output_alias.clone()));
                output_field_names.insert(&key.output_alias);
            }
        }

        // Create the grouping
        let mut grouping_set = Vec::new();
        grouping_set.resize(grouping_exprs.len(), false);
        let grouping = PhysicalGroupBy::new(grouping_exprs, Vec::new(), vec![grouping_set]);

        let aggregate_exprs: Vec<AggregateFunctionExpr> = Vec::new();
        for _aggr in config.aggregates.iter() {
            // XXX
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
