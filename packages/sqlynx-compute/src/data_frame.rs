use std::sync::Arc;

use arrow::{array::RecordBatch, datatypes::Schema};
use datafusion_execution::TaskContext;
use datafusion_physical_expr::{expressions::col, PhysicalSortExpr};
use datafusion_physical_plan::{collect, memory::MemoryExec, sorts::sort::SortExec};
use prost::Message;
use wasm_bindgen::prelude::*;

use crate::{arrow_out::DataFrameIpcStream, proto::sqlynx_compute::OrderByConfig, proto::sqlynx_compute::GroupByConfig};

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
    #[wasm_bindgen(js_name="orderBy")]
    pub async fn order_by(&self, proto: &[u8]) -> Result<DataFrame, JsError> {
        let config = OrderByConfig::decode(proto)?;

        let mut sort_exprs: Vec<PhysicalSortExpr> = Vec::new();
        for constraint in config.constraints.iter() {
            // Construct the new sort order
            let sort_options = arrow::compute::SortOptions {
                descending: !constraint.ascending,
                nulls_first: constraint.nulls_first,
            };
            sort_exprs.push(PhysicalSortExpr {
                expr: col(&constraint.field_name, &self.schema)?,
                options: sort_options,
            });
        }
        let input = Arc::new(
            MemoryExec::try_new(&self.partitions, self.schema.clone(), None).unwrap(),
        );
        let sort_limit = config.limit.map(|l| l as usize);
        let sort_exec = Arc::new(SortExec::new(
            sort_exprs,
            input,
        ).with_fetch(sort_limit));

        // Construct the new memtable
        let task_ctx = Arc::new(TaskContext::default());
        let result = collect(sort_exec, Arc::clone(&task_ctx)).await?;

        let sorted = DataFrame::new(self.schema.clone(), result);
        return Ok(sorted);
    }

    /// Group a data frame
    #[wasm_bindgen(js_name="groupBy")]
    pub async fn group_by(&self, proto: &[u8]) -> Result<DataFrame, JsError> {
        let _config = GroupByConfig::decode(proto)?;


        return Err(JsError::new("not implemented"));
    }

    /// Group a data frame with precomputed statistics (for example needed for binning)
    #[wasm_bindgen(js_name="groupByWithStats")]
    pub async fn group_by_with_stats(&self, proto: &[u8], _stats: &DataFrame) -> Result<DataFrame, JsError> {
        let _config = GroupByConfig::decode(proto)?;


        return Err(JsError::new("not implemented"));
    }
}
