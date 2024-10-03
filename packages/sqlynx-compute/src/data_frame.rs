use std::sync::Arc;

use arrow::{array::RecordBatch, datatypes::Schema};
use datafusion_execution::TaskContext;
use datafusion_physical_expr::{expressions::col, PhysicalSortExpr};
use datafusion_physical_plan::{collect, memory::MemoryExec, sorts::sort::SortExec};
use prost::Message;
use wasm_bindgen::prelude::*;

use crate::{arrow_out::DataFrameIpcStream, proto::OrderByConfig};

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

    /// Reorder the frame by a single column
    #[wasm_bindgen(js_name="orderBy")]
    pub async fn order_by(&self, proto: &[u8]) -> Result<DataFrame, JsError> {
        let config = OrderByConfig::decode(proto)?;

        // Find the column id
        let column_id = match self.schema.index_of(&config.field_name) {
            Ok(cid) => cid,
            Err(_) => return Err(JsError::new("column does not refer to a schema field")),
        };
        let input = Arc::new(
            MemoryExec::try_new(&self.partitions, self.schema.clone(), None).unwrap(),
        );

        // Construct the new sort order
        let column_name = self.schema.fields()[column_id].name();
        let sort_options = arrow::compute::SortOptions {
            descending: !config.ascending,
            nulls_first: config.nulls_first,
        };
        let sort_limit = config.limit.map(|l| l as usize);
        let sort_exec = Arc::new(SortExec::new(
            vec![PhysicalSortExpr {
                expr: col(column_name, &self.schema)?,
                options: sort_options,
            }],
            input,
        ).with_fetch(sort_limit));

        // Construct the new memtable
        let task_ctx = Arc::new(TaskContext::default());
        let result = collect(sort_exec, Arc::clone(&task_ctx)).await?;

        let sorted = DataFrame::new(self.schema.clone(), result);
        return Ok(sorted);
    }

    #[wasm_bindgen(js_name="createIpcStream")]
    pub fn create_ipc_stream(&self) -> Result<DataFrameIpcStream, JsError> {
        DataFrameIpcStream::new(self.schema.clone())
    }
}
