use std::sync::Arc;

use datafusion::catalog::TableProvider;
use datafusion::datasource::MemTable;
use datafusion::prelude::*;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct DataFrame {
    /// The input stream
    table: Arc<MemTable>,
}

#[wasm_bindgen]
impl DataFrame {
    /// Construct a data frame
    pub(crate) fn new(table: Arc<MemTable>) -> DataFrame {
        Self {
            table
        }
    }

    /// Reorder the frame by a single column
    pub async fn order_by_column(&self, column_id: usize, ascending: bool, nulls_first: bool) -> Result<DataFrame, JsError> {
        let ctx = SessionContext::new();
        let table_provider = self.table.clone() as Arc<dyn TableProvider>;
        let schema = table_provider.schema().clone();

        // Is the column id referring to a valid column?
        if column_id >= schema.fields().len() {
            return Err(JsError::new("column does not refer to a schema field"));
        }

        // Construct the new sort order
        let column_name = schema.fields()[column_id].name();
        let column = Column::from_name(column_name);
        let sort_order = vec![col(column).sort(ascending, nulls_first)];

        // Sort the table
        let batches = ctx.read_table(table_provider)?
            .sort(sort_order.clone())?
            .collect().await?;

        // Construct the new memtable
        let mut mem_table = MemTable::try_new(schema, vec![batches])?;
        mem_table = mem_table.with_sort_order(vec![sort_order]);
        let sorted = DataFrame::new(Arc::new(mem_table));
        return Ok(sorted);
    }
}
