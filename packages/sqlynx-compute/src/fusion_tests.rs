use std::sync::Arc;

use arrow::{array::{ArrayData, ArrayRef, Decimal128Array, Int32Array, RecordBatch}, buffer::Buffer, datatypes::{Field, SchemaBuilder}};
use datafusion_common::scalar::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_physical_expr::{expressions::{col, Column, Literal, BinaryExpr}, PhysicalSortExpr};
use datafusion_physical_plan::{collect, filter::FilterExec, memory::MemoryExec, sorts::sort::SortExec, ExecutionPlan};


#[tokio::test]
async fn test_filter_sort() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("bank_account", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None).unwrap(),
    );
    let sort_exec = Arc::new(SortExec::new(
        vec![PhysicalSortExpr {
            expr: col("bank_account", &data.schema())?,
            options: arrow::compute::SortOptions::default(),
        }],
        input,
    ));
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(sort_exec, Arc::clone(&task_ctx)).await?;

    assert_eq!(result.len(), 1);
    Ok(())
}

#[tokio::test]
async fn test_decimal_literal_filter() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", arrow::datatypes::DataType::Int32, false));
    schema_builder.push(Field::new("score", arrow::datatypes::DataType::Decimal128(38, 18), false));
    let schema = schema_builder.finish();

    let decimal_data = ArrayData::builder(arrow::datatypes::DataType::Decimal128(38, 18))
        .len(3)
        .add_buffer(Buffer::from_vec(vec![
            42_i128 * 10_i128.pow(18) + 5_i128 * 10_i128.pow(17),
            42_i128 * 10_i128.pow(18),
            5_i128 * 10_i128.pow(17),
        ]))
        .build()
        .unwrap();
    let decimal_array = Decimal128Array::from(decimal_data);

    let record_batch = RecordBatch::try_new(schema.into(), vec![
        Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef,
        Arc::new(decimal_array)
    ])?;

    let boundary = 42_i128 * 10_i128.pow(18) + 4_i128 * 10_i128.pow(17);
    let literal_value = ScalarValue::Decimal128(Some(boundary), 38, 18);

    let predicate = Arc::new(BinaryExpr::new(
            Arc::new(Column::new("score", 1)),
            datafusion_expr::Operator::Lt,
            Arc::new(Literal::new(literal_value)),
        ));

    let input = Arc::new(
        MemoryExec::try_new(&[vec![record_batch.clone()]], record_batch.schema(), None).unwrap(),
    );
    let sort_exec = Arc::new(SortExec::new(
        vec![PhysicalSortExpr {
            expr: col("score", &record_batch.schema())?,
            options: arrow::compute::SortOptions::default(),
        }],
        input,
    ));
    let filter_exec: Arc<dyn ExecutionPlan> =
        Arc::new(FilterExec::try_new(predicate, sort_exec)?);

    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(filter_exec, Arc::clone(&task_ctx)).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].num_rows(), 2);
    Ok(())
}
