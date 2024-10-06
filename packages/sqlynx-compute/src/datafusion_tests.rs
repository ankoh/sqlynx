use arrow::array::{ArrayData, ArrayRef, AsArray, Decimal128Array, Int32Array, RecordBatch, StringArray};
use arrow::array::TimestampMillisecondArray;
use arrow::datatypes::{Field, Int64Type, SchemaBuilder, TimestampMillisecondType};
use arrow::buffer::Buffer;
use arrow::datatypes::DataType;
use arrow::util::pretty::pretty_format_batches;
use chrono::DateTime;
use datafusion_common::scalar::ScalarValue;
use datafusion_execution::TaskContext;
use datafusion_expr::AggregateUDF;
use datafusion_expr::Operator;
use datafusion_functions_aggregate::{count::count_udaf, min_max::{Max, Min}};
use datafusion_physical_expr::PhysicalSortExpr;
use datafusion_physical_expr::aggregate::AggregateExprBuilder;
use datafusion_physical_expr::expressions::{binary, col, lit, BinaryExpr, Column, Literal, CastExpr};
use datafusion_physical_plan::ExecutionPlan;
use datafusion_physical_plan::aggregates::{AggregateMode, AggregateExec, PhysicalGroupBy};
use datafusion_physical_plan::collect;
use datafusion_physical_plan::filter::FilterExec;
use datafusion_physical_plan::memory::MemoryExec;
use datafusion_physical_plan::projection::ProjectionExec;
use datafusion_physical_plan::sorts::sort::SortExec;
use indoc::indoc;
use pretty_assertions::assert_eq;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

#[tokio::test]
async fn test_filter_sort() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("score", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None).unwrap(),
    );
    let sort_exec = Arc::new(SortExec::new(
        vec![PhysicalSortExpr {
            expr: col("score", &data.schema())?,
            options: arrow::compute::SortOptions::default(),
        }],
        input,
    ));
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(sort_exec, Arc::clone(&task_ctx)).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +----+-------+
        | id | score |
        +----+-------+
        | 3  | 7000  |
        | 2  | 8000  |
        | 1  | 9000  |
        +----+-------+
    "}.trim());
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
    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +----+-----------------------+
        | id | score                 |
        +----+-----------------------+
        | 3  | 0.500000000000000000  |
        | 2  | 42.000000000000000000 |
        +----+-----------------------+
    "}.trim());
    Ok(())
}


#[tokio::test]
async fn test_group_by_1phase_1key() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", arrow::datatypes::DataType::Int32, false));
    schema_builder.push(Field::new("value", arrow::datatypes::DataType::Int32, false));
    let schema = schema_builder.finish();
    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(Int32Array::from(vec![1, 3, 2, 2, 3])) as ArrayRef,
        Arc::new(Int32Array::from(vec![100, 200, 300, 400, 500])) as ArrayRef
    ])?;

    let col_value = col("value", data.schema_ref())?;
    let grouping = PhysicalGroupBy::new(
        vec![(col("id", data.schema_ref())?, "key".to_string())],
        vec![],
        vec![vec![false]]
    );

    let udaf_min = Arc::new(AggregateUDF::new_from_impl(Min::new()));
    let udaf_max = Arc::new(AggregateUDF::new_from_impl(Max::new()));
    let udaf_count = count_udaf();

    let value_min = AggregateExprBuilder::new(udaf_min, vec![col_value.clone()])
        .schema(data.schema())
        .alias("min")
        .build()?;
    let value_max = AggregateExprBuilder::new(udaf_max, vec![col_value.clone()])
        .schema(data.schema())
        .alias("max")
        .build()?;
    let value_count = AggregateExprBuilder::new(udaf_count, vec![col_value.clone()])
        .schema(data.schema())
        .alias("count")
        .build()?;

    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None)?,
    );
    let groupby_exec = Arc::new(AggregateExec::try_new(
        AggregateMode::Single,
        grouping.clone(),
        vec![
            value_min,
            value_max,
            value_count,
        ],
        vec![
            None,
            None,
            None,
        ],
        input.clone(),
        data.schema()
    )?);
    let sort_exec = Arc::new(SortExec::new(
        vec![PhysicalSortExpr {
            expr: col("key", &groupby_exec.schema())?,
            options: arrow::compute::SortOptions::default(),
        }],
        groupby_exec.clone(),
    ));
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(sort_exec, task_ctx.clone()).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].num_columns(), 4);
    assert_eq!(result[0].num_rows(), 3);

    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +-----+-----+-----+-------+
        | key | min | max | count |
        +-----+-----+-----+-------+
        | 1   | 100 | 100 | 1     |
        | 2   | 300 | 400 | 2     |
        | 3   | 200 | 500 | 2     |
        +-----+-----+-----+-------+
    "}.trim());

    Ok(())
}

#[tokio::test]
async fn test_string_array() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", DataType::Utf8, false));
    schema_builder.push(Field::new("value", DataType::Utf8, false));
    let schema = schema_builder.finish();
    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(StringArray::from(vec![
            "860f346a-5e02-4f32-93db-6c54378e31bb/0",
            "860f346a-5e02-4f32-93db-6c54378e31bb/3",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
        ])) as ArrayRef,
        Arc::new(StringArray::from(vec![
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/0",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/1",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/2",
        ])) as ArrayRef,
    ])?;
    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None).unwrap(),
    );
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(input, Arc::clone(&task_ctx)).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +----------------------------------------+----------------------------------------+
        | id                                     | value                                  |
        +----------------------------------------+----------------------------------------+
        | 860f346a-5e02-4f32-93db-6c54378e31bb/0 | 5f20bedd-6ee4-4df9-8cac-2d4907900011/0 |
        | 860f346a-5e02-4f32-93db-6c54378e31bb/3 | 5f20bedd-6ee4-4df9-8cac-2d4907900011/1 |
        | 860f346a-5e02-4f32-93db-6c54378e31bb/1 | 5f20bedd-6ee4-4df9-8cac-2d4907900011/2 |
        +----------------------------------------+----------------------------------------+
    "}.trim());
    Ok(())
}


#[tokio::test]
async fn test_group_by_1phase_1key_distinct() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", DataType::Utf8, false));
    schema_builder.push(Field::new("value", DataType::Utf8, false));
    let schema = schema_builder.finish();
    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(StringArray::from(vec![
            "860f346a-5e02-4f32-93db-6c54378e31bb/0",
            "860f346a-5e02-4f32-93db-6c54378e31bb/3",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/2",
            "860f346a-5e02-4f32-93db-6c54378e31bb/3",
            "860f346a-5e02-4f32-93db-6c54378e31bb/5",
            "860f346a-5e02-4f32-93db-6c54378e31bb/5",
        ])) as ArrayRef,
        Arc::new(StringArray::from(vec![
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/0",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/1",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/2",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/2",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/4",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/5",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/1",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/7",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/8",
        ])) as ArrayRef,
    ])?;

    let col_value = col("value", data.schema_ref())?;
    let grouping = PhysicalGroupBy::new(
        vec![(col("id", data.schema_ref())?, "key".to_string())],
        vec![],
        vec![vec![false]]
    );

    let udaf_count = count_udaf();
    let value_count = AggregateExprBuilder::new(udaf_count.clone(), vec![col_value.clone()])
        .schema(data.schema())
        .alias("count")
        .build()?;
    let value_count_distinct = AggregateExprBuilder::new(udaf_count.clone(), vec![col_value.clone()])
        .schema(data.schema())
        .alias("count_distinct")
        .distinct()
        .build()?;

    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None)?,
    );
    let groupby_exec = Arc::new(AggregateExec::try_new(
        AggregateMode::Single,
        grouping.clone(),
        vec![value_count, value_count_distinct],
        vec![None, None],
        input.clone(),
        data.schema()
    )?);
    let sort_exec = Arc::new(SortExec::new(
        vec![PhysicalSortExpr {
            expr: col("key", &groupby_exec.schema())?,
            options: arrow::compute::SortOptions::default(),
        }],
        groupby_exec.clone(),
    ));
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(sort_exec, task_ctx.clone()).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +----------------------------------------+-------+----------------+
        | key                                    | count | count_distinct |
        +----------------------------------------+-------+----------------+
        | 860f346a-5e02-4f32-93db-6c54378e31bb/0 | 1     | 1              |
        | 860f346a-5e02-4f32-93db-6c54378e31bb/1 | 3     | 2              |
        | 860f346a-5e02-4f32-93db-6c54378e31bb/2 | 1     | 1              |
        | 860f346a-5e02-4f32-93db-6c54378e31bb/3 | 2     | 1              |
        | 860f346a-5e02-4f32-93db-6c54378e31bb/5 | 2     | 2              |
        +----------------------------------------+-------+----------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_group_by_1phase_static_distinct() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", DataType::Utf8, false));
    schema_builder.push(Field::new("value", DataType::Utf8, false));
    let schema = schema_builder.finish();
    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(StringArray::from(vec![
            "860f346a-5e02-4f32-93db-6c54378e31bb/0",
            "860f346a-5e02-4f32-93db-6c54378e31bb/3",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/2",
            "860f346a-5e02-4f32-93db-6c54378e31bb/3",
            "860f346a-5e02-4f32-93db-6c54378e31bb/5",
            "860f346a-5e02-4f32-93db-6c54378e31bb/5",
        ])) as ArrayRef,
        Arc::new(StringArray::from(vec![
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/0",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/1",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/2",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/2",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/4",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/5",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/1",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/7",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011/8",
        ])) as ArrayRef,
    ])?;

    let col_id = col("id", data.schema_ref())?;
    let col_value = col("value", data.schema_ref())?;
    let grouping = PhysicalGroupBy::new(vec![], vec![], vec![]);

    let udaf_count = count_udaf();
    let cd_id = AggregateExprBuilder::new(udaf_count.clone(), vec![col_id.clone()])
        .schema(data.schema())
        .alias("cd_id")
        .distinct()
        .build()?;
    let cd_val = AggregateExprBuilder::new(udaf_count.clone(), vec![col_value.clone()])
        .schema(data.schema())
        .alias("cd_value")
        .distinct()
        .build()?;

    let input = Arc::new(
        MemoryExec::try_new(&[vec![data.clone()]], data.schema(), None)?,
    );
    let groupby_exec = Arc::new(AggregateExec::try_new(
        AggregateMode::Single,
        grouping.clone(),
        vec![cd_id.clone(), cd_val.clone()],
        vec![None, None],
        input.clone(),
        data.schema()
    )?);
    let task_ctx = Arc::new(TaskContext::default());
    let result = collect(groupby_exec, task_ctx.clone()).await?;

    assert_eq!(result.len(), 1);
    assert_eq!(format!("{}", pretty_format_batches(&result)?), indoc! {"
        +-------+----------+
        | cd_id | cd_value |
        +-------+----------+
        | 5     | 7        |
        +-------+----------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_bin_timestamps() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("id", DataType::Int32, false));
    schema_builder.push(Field::new("when", DataType::Timestamp(arrow::datatypes::TimeUnit::Millisecond, None), false));
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
    let minmax_bin_width = binary(
        minmax_ms.clone(),
        Operator::Divide,
        lit(ScalarValue::Int64(Some(64))),
        data.schema_ref())?;

    let projection_exec = Arc::new(ProjectionExec::try_new(
        vec![
            (col("min", &groupby_exec.schema())?, "min".to_string()),
            (col("max", &groupby_exec.schema())?, "max".to_string()),
            (minmax_diff, "diff".to_string()),
            (minmax_ms, "diff_ms".to_string()),
            (minmax_bin_width, "diff_bin_width".to_string())
        ],
        groupby_exec
    )?);

    let task_ctx = Arc::new(TaskContext::default());
    let minmax_result = collect(projection_exec, task_ctx.clone()).await?;

    assert_eq!(minmax_result.len(), 1);
    assert_eq!(format!("{}", pretty_format_batches(&minmax_result)?), indoc! {"
        +---------------------+---------------------+-----------+-----------+----------------+
        | min                 | max                 | diff      | diff_ms   | diff_bin_width |
        +---------------------+---------------------+-----------+-----------+----------------+
        | 2024-04-01T12:00:00 | 2024-04-03T12:00:00 | PT172800S | 172800000 | 2700000        |
        +---------------------+---------------------+-----------+-----------+----------------+
    "}.trim());

    let min_col = minmax_result[0].column(0).as_primitive::<TimestampMillisecondType>();
    let max_col = minmax_result[0].column(1).as_primitive::<TimestampMillisecondType>();
    let diff_ms_col = minmax_result[0].column(3).as_primitive::<Int64Type>();
    let bin_width_col = minmax_result[0].column(4).as_primitive::<Int64Type>();
    assert_eq!(min_col.value_as_datetime(0).unwrap().to_string(), "2024-04-01 12:00:00");
    assert_eq!(max_col.value_as_datetime(0).unwrap().to_string(), "2024-04-03 12:00:00");
    assert_eq!(diff_ms_col.value(0), 172800000);
    assert_eq!(bin_width_col.value(0), 2700000);

    let when_diff = binary(
        col("when", data.schema_ref())?,
        Operator::Minus,
        lit(ScalarValue::TimestampMillisecond(Some(min_col.value(0)), None)),
        data.schema_ref())?;
    let when_diff_ms = Arc::new(CastExpr::new(when_diff, DataType::Int64, None));
    let when_diff_bin = binary(
        when_diff_ms,
        Operator::Divide,
        lit(ScalarValue::Int64(Some(bin_width_col.value(0)))),
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
        | 2  | 32  |
        | 3  | 64  |
        +----+-----+
    "}.trim());

    Ok(())
}
