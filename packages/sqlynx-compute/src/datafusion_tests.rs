use std::sync::Arc;

use arrow::{array::{ArrayData, ArrayRef, Decimal128Array, Int32Array, RecordBatch}, buffer::Buffer, datatypes::{Field, SchemaBuilder}};
use datafusion::{prelude::*, scalar::ScalarValue};


#[tokio::test]
async fn test_filter_sort() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("bank_account", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let ctx = SessionContext::new();
    let df = ctx
        .read_batch(data)?
        .filter(col("bank_account").gt_eq(lit(8000)))?
        .sort(vec![col("bank_account").sort(false, true)])?;

    let result = df.collect().await?;
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

    let ctx = SessionContext::new();
    let df = ctx
        .read_batch(record_batch)?
        .filter(col("score").lt(lit(literal_value)))?
        .sort(vec![col("score").sort(true, true)])?;

    let result = df.collect().await?;
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].num_rows(), 2);

    Ok(())
}
