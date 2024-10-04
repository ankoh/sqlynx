use arrow::array::{ArrayRef, AsArray, Int32Array, RecordBatch, TimestampMillisecondArray};
use arrow::datatypes::{Field, Int64Type, SchemaBuilder, TimestampMillisecondType};
use arrow::datatypes::DataType;
use arrow::datatypes::TimeUnit;
use arrow::util::pretty::pretty_format_batches;
use chrono::DateTime;
use datafusion_common::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_expr::AggregateUDF;
use datafusion_expr::Operator;
use datafusion_functions_aggregate::min_max::{Max, Min};
use datafusion_physical_expr::aggregate::AggregateExprBuilder;
use datafusion_physical_expr::expressions::{binary, CastExpr};
use datafusion_physical_expr::expressions::col;
use datafusion_physical_expr::expressions::lit;
use datafusion_physical_plan::aggregates::{AggregateMode, AggregateExec, PhysicalGroupBy};
use datafusion_physical_plan::{collect, ExecutionPlan};
use datafusion_physical_plan::memory::MemoryExec;
use datafusion_physical_plan::projection::ProjectionExec;
use indoc::indoc;
use pretty_assertions::assert_eq;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn test_bin_timestamps() -> anyhow::Result<()> {
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

    let when_max = AggregateExprBuilder::new(udaf_max, vec![col_when.clone()])
        .schema(data.schema())
        .alias("max")
        .build()?;
    let when_min = AggregateExprBuilder::new(udaf_min, vec![col_when.clone()])
        .schema(data.schema())
        .alias("min")
        .build()?;

    let data_scan = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None)?,
    );
    let groupby_exec = Arc::new(AggregateExec::try_new(
        AggregateMode::Single,
        grouping.clone(),
        vec![when_min, when_max],
        vec![None, None],
        data_scan.clone(),
        data.schema()
    )?);
    let minmax_diff = binary(
        col("max", &groupby_exec.schema())?,
        Operator::Minus,
        col("min", &groupby_exec.schema())?,
        &groupby_exec.schema())?;
    let minmax_ms = Arc::new(CastExpr::new(minmax_diff.clone(), DataType::Int64, None));

    let projection_exec = Arc::new(ProjectionExec::try_new(
        vec![
            (col("min", &groupby_exec.schema())?, "min".to_string()),
            (col("max", &groupby_exec.schema())?, "max".to_string()),
            (minmax_diff, "diff".to_string()),
            (minmax_ms, "diff_ms".to_string())
        ],
        groupby_exec
    )?);

    let task_ctx = Arc::new(TaskContext::default());
    let minmax_result = collect(projection_exec, task_ctx.clone()).await?;

    assert_eq!(minmax_result.len(), 1);
    assert_eq!(format!("{}", pretty_format_batches(&minmax_result)?), indoc! {"
        +---------------------+---------------------+-----------+-----------+
        | min                 | max                 | diff      | diff_ms   |
        +---------------------+---------------------+-----------+-----------+
        | 2024-04-01T12:00:00 | 2024-04-03T12:00:00 | PT172800S | 172800000 |
        +---------------------+---------------------+-----------+-----------+
    "}.trim());

    let min_col = minmax_result[0].column(0).as_primitive::<TimestampMillisecondType>();
    let max_col = minmax_result[0].column(1).as_primitive::<TimestampMillisecondType>();
    let diff_ms_col = minmax_result[0].column(3).as_primitive::<Int64Type>();
    assert_eq!(min_col.value_as_datetime(0).unwrap().to_string(), "2024-04-01 12:00:00");
    assert_eq!(max_col.value_as_datetime(0).unwrap().to_string(), "2024-04-03 12:00:00");
    assert_eq!(diff_ms_col.value(0), 172800000);

    let range_millis = diff_ms_col.value(0);
    let bin_millis = range_millis / 100;

    // Maybe we get around date_part here for now by just casting to milliseconds.
    // Otherwise, we can fall back to:
    // let date_part_udf = Arc::new(ScalarUDF::new_from_impl(DatePartFunc::new()));
    // let diff_extract = Arc::new(ScalarFunctionExpr::new("min_ms", date_part_udf.clone(), vec![lit("day"), time_diff.clone()], DataType::Float64));
    // let time_diff_cast = Arc::new(CastExpr::new(time_diff.clone(), DataType::Int64, None));

    let when_diff = binary(
        col("when", data.schema_ref())?,
        Operator::Minus,
        lit(ScalarValue::TimestampMillisecond(Some(min_col.value(0)), None)),
        data.schema_ref())?;
    let when_diff_ms = Arc::new(CastExpr::new(when_diff, DataType::Int64, None));
    let when_diff_bin = binary(
        when_diff_ms,
        Operator::Divide,
        lit(ScalarValue::Int64(Some(bin_millis))),
        data.schema_ref())?;

    let data_scan = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None)?,
    );
    let projection_exec = Arc::new(ProjectionExec::try_new(
        vec![
            (col("id", data.schema_ref())?, "id".to_string()),
            (when_diff_bin, "bin".to_string())
        ],
        data_scan
    )?);
    let task_ctx = Arc::new(TaskContext::default());
    let projection_result = collect(projection_exec, task_ctx.clone()).await?;

    assert_eq!(projection_result.len(), 1);
    assert_eq!(projection_result[0].num_columns(), 2);
    assert_eq!(projection_result[0].num_rows(), 3);
    assert_eq!(format!("{}", pretty_format_batches(&projection_result)?), indoc! {"
        +----+-----+
        | id | bin |
        +----+-----+
        | 1  | 0   |
        | 2  | 50  |
        | 3  | 100 |
        +----+-----+
    "}.trim());

    Ok(())
}
