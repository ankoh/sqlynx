use arrow::array::{ArrayRef, Int32Array, RecordBatch, TimestampMillisecondArray};
use arrow::datatypes::{Field, SchemaBuilder};
use arrow::datatypes::DataType;
use arrow::datatypes::TimeUnit;
use arrow::util::pretty::pretty_format_batches;
use chrono::DateTime;
use datafusion_execution::TaskContext;
use datafusion_expr::AggregateUDF;
use datafusion_functions_aggregate::min_max::{Max, Min};
use datafusion_physical_expr::aggregate::AggregateExprBuilder;
use datafusion_physical_expr::expressions::col;
use datafusion_physical_plan::aggregates::{AggregateMode, AggregateExec, PhysicalGroupBy};
use datafusion_physical_plan::collect;
use datafusion_physical_plan::memory::MemoryExec;
use indoc::indoc;
use pretty_assertions::assert_eq;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn test_minmax_timestamp() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", DataType::Int32, false));
    schema_builder.push(Field::new("when", DataType::Timestamp(TimeUnit::Millisecond, None), false));
    let schema = schema_builder.finish();

    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef,
        Arc::new(TimestampMillisecondArray::from(
            vec![
                SystemTime::from(DateTime::parse_from_rfc3339("2024-04-01T12:00:00-00:00")?)
                    .duration_since(UNIX_EPOCH)?
                    .as_millis() as i64,
                SystemTime::from(DateTime::parse_from_rfc3339("2024-04-02T12:00:00-00:00")?)
                    .duration_since(UNIX_EPOCH)?
                    .as_millis() as i64,
                SystemTime::from(DateTime::parse_from_rfc3339("2024-04-03T12:00:00-00:00")?)
                    .duration_since(UNIX_EPOCH)?
                    .as_millis() as i64,
            ]
        )) as ArrayRef,
    ])?;
    let col_when = col("when", data.schema_ref())?;

    let grouping = PhysicalGroupBy::new(vec![], vec![], vec![]);
    let udaf_min = Arc::new(AggregateUDF::new_from_impl(Min::new()));
    let udaf_max = Arc::new(AggregateUDF::new_from_impl(Max::new()));

    let when_min = AggregateExprBuilder::new(udaf_min, vec![col_when.clone()])
        .schema(data.schema())
        .alias("min")
        .build()?;
    let when_max = AggregateExprBuilder::new(udaf_max, vec![col_when.clone()])
        .schema(data.schema())
        .alias("max")
        .build()?;

    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None)?,
    );
    let groupby_exec = Arc::new(AggregateExec::try_new(
        AggregateMode::Single,
        grouping.clone(),
        vec![when_min, when_max],
        vec![None, None],
        input.clone(),
        data.schema()
    )?);
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(groupby_exec, task_ctx.clone()).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].num_columns(), 2);
    assert_eq!(result[0].num_rows(), 1);

    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +---------------------+---------------------+
        | min                 | max                 |
        +---------------------+---------------------+
        | 2024-04-01T12:00:00 | 2024-04-03T12:00:00 |
        +---------------------+---------------------+
    "}.trim());

    Ok(())
}
