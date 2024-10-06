use arrow::array::{ArrayRef, Float32Builder, Int32Array, Int64Array, ListBuilder, RecordBatch, StringArray, TimestampMillisecondArray, TimestampMillisecondBufferBuilder};
use arrow::datatypes::{Field, SchemaBuilder, DataType};
use arrow::util::pretty::pretty_format_batches;
use chrono::{DateTime, Duration};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use indoc::indoc;
use pretty_assertions::assert_eq;

use crate::proto::sqlynx_compute::{AggregationFunction, GroupByAggregate, GroupByKey, GroupByKeyBinning};
use crate::proto::sqlynx_compute::{DataFrameTransform, OrderByConstraint, OrderByTransform, GroupByTransform};
use crate::data_frame::DataFrame;

#[tokio::test]
async fn test_transform_orderby() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("score", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        group_by: None,
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "score".to_string(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        }),
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
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
async fn test_minmax_int64() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("score", Arc::new(Int64Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "score".into(),
                    output_alias: "score_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
                },
                GroupByAggregate {
                    field_name: "score".into(),
                    output_alias: "score_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
                }
            ]
        }),
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +-----------+-----------+
        | score_min | score_max |
        +-----------+-----------+
        | 7000      | 9000      |
        +-----------+-----------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_minmax_string() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("v1", DataType::Utf8, false));
    schema_builder.push(Field::new("v2", DataType::Utf8, false));
    let schema = schema_builder.finish();
    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(StringArray::from(vec![
            "860f346a-5e02-4f32-93db-6c54378e31bb/0",
            "860f346a-5e02-4f32-93db-6c54378e31bb/1",
            "860f346a-5e02-4f32-93db-6c54378e31bb/2",
            "860f346a-5e02-4f32-93db-6c54378e31bb/3",
            "860f346a-5e02-4f32-93db-6c54378e31bb/4",
            "860f346a-5e02-4f32-93db-6c54378e31bb/5",
            "860f346a-5e02-4f32-93db-6c54378e31bb/6",
            "860f346a-5e02-4f32-93db-6c54378e31bb/7",
            "860f346a-5e02-4f32-93db-6c54378e31bb/8",
        ])) as ArrayRef,
        Arc::new(StringArray::from(vec![
            "5f20bedd",
            "5f20bedd-6ee4",
            "5f20bedd",
            "5f20bedd-6ee4-4df9",
            "5f20bedd-6ee4",
            "5f20bedd-6ee4-4df9-8cac",
            "5f20bedd-6ee4-4df9",
            "5f20bedd-6ee4-4df9-8cac-2d4907900011",
            "5f20bedd-6ee4-4df9-8cac-2d4907900012",
        ])) as ArrayRef,
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "v1".into(),
                    output_alias: "v1_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
                },
                GroupByAggregate {
                    field_name: "v1".into(),
                    output_alias: "v1_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
                },
                GroupByAggregate {
                    field_name: "v2".into(),
                    output_alias: "v2_chars_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "v2".into(),
                    output_alias: "v2_chars_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                }
            ]
        }),
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +----------------------------------------+----------------------------------------+--------------+--------------+
        | v1_min                                 | v1_max                                 | v2_chars_min | v2_chars_max |
        +----------------------------------------+----------------------------------------+--------------+--------------+
        | 860f346a-5e02-4f32-93db-6c54378e31bb/0 | 860f346a-5e02-4f32-93db-6c54378e31bb/8 | 8            | 36           |
        +----------------------------------------+----------------------------------------+--------------+--------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_minmax_embeddings() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(1);
    let list_item_type = Arc::new(Field::new("item", DataType::Float32, true));
    let list_type = DataType::List(list_item_type.clone());
    schema_builder.push(Field::new("v1", list_type, true));
    let schema = schema_builder.finish();

    let float_builder = Float32Builder::with_capacity(5);
    let mut embeddings = ListBuilder::new(float_builder);

    embeddings.values().append_value(1.0);
    embeddings.values().append_value(2.0);
    embeddings.values().append_value(5.0);
    embeddings.append(true);
    embeddings.values().append_value(6.0);
    embeddings.values().append_value(7.0);
    embeddings.values().append_value(8.0);
    embeddings.values().append_value(9.0);
    embeddings.values().append_value(10.0);
    embeddings.append(true);

    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(embeddings.finish()) as ArrayRef,
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "v1".into(),
                    output_alias: "v1_len_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "v1".into(),
                    output_alias: "v1_len_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                }
            ]
        }),
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +------------+------------+
        | v1_len_min | v1_len_max |
        +------------+------------+
        | 3          | 5          |
        +------------+------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_timestamps() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("ts", DataType::Timestamp(arrow::datatypes::TimeUnit::Millisecond, None), false));
    let schema = schema_builder.finish();

    let mut ts_buf = TimestampMillisecondBufferBuilder::new(10);
    let ts_base = DateTime::parse_from_rfc3339("2024-04-01T12:00:00-00:00")?;
    let mut next_ts = ts_base.clone();
    for _ in 0..7 {
        next_ts += Duration::hours(1);
        let ms = SystemTime::from(next_ts).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        ts_buf.append(ms);
    }
    ts_buf.append(SystemTime::from(ts_base + Duration::hours(2)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64);
    ts_buf.append(SystemTime::from(ts_base + Duration::hours(2)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64);
    ts_buf.append(SystemTime::from(ts_base + Duration::hours(5)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64);
    let ts_array = Arc::new(TimestampMillisecondArray::new(ts_buf.finish().into(), None));

    let data = RecordBatch::try_new(schema.into(), vec![ts_array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    let stats_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "ts".into(),
                    output_alias: "ts_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "ts".into(),
                    output_alias: "ts_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +---------------------+---------------------+
        | ts_min              | ts_max              |
        +---------------------+---------------------+
        | 2024-04-01T13:00:00 | 2024-04-01T19:00:00 |
        +---------------------+---------------------+
    "}.trim());

    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 64
                    })
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "ts".into(),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
                },
            ]
        }),
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "ts_bin".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        })
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +--------+----------+
        | ts_bin | ts_count |
        +--------+----------+
        | 0      | 1        |
        | 10     | 3        |
        | 21     | 1        |
        | 32     | 1        |
        | 42     | 2        |
        | 53     | 1        |
        | 64     | 1        |
        +--------+----------+
    "}.trim());
    Ok(())
}
