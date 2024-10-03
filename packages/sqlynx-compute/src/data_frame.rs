use std::sync::Arc;

use arrow::{array::RecordBatch, datatypes::Schema};
use datafusion_execution::TaskContext;
use datafusion_physical_expr::{expressions::col, PhysicalSortExpr};
use datafusion_physical_plan::{collect, memory::MemoryExec, sorts::sort::SortExec};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DataFrame {
    schema: Arc<Schema>,
    batches: Vec<Vec<RecordBatch>>,
}

#[wasm_bindgen]
impl DataFrame {
    /// Construct a data frame
    pub(crate) fn new(schema: Arc<Schema>, batches: Vec<RecordBatch>) -> DataFrame {
        Self {
            schema, batches: vec![batches]
        }
    }

    /// Reorder the frame by a single column
    pub async fn order_by_column(&self, column_id: usize, _ascending: bool, _nulls_first: bool) -> Result<DataFrame, JsError> {
        // Is the column id referring to a valid column?
        if column_id >= self.schema.fields().len() {
            return Err(JsError::new("column does not refer to a schema field"));
        }
        let input = Arc::new(
            MemoryExec::try_new(&self.batches, self.schema.clone(), None).unwrap(),
        );

        // Construct the new sort order
        let column_name = self.schema.fields()[column_id].name();
        let sort_exec = Arc::new(SortExec::new(
            vec![PhysicalSortExpr {
                expr: col(column_name, &self.schema)?,
                options: arrow::compute::SortOptions::default(),
            }],
            input,
        ));


        // Construct the new memtable
        let task_ctx = Arc::new(TaskContext::default());
        let result = collect(sort_exec, Arc::clone(&task_ctx)).await?;

        let sorted = DataFrame::new(self.schema.clone(), result);
        return Ok(sorted);
    }
}
