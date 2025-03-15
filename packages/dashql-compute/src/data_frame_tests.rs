use arrow::array::{ArrayRef, ArrowNativeTypeOp, Date32Array, Date32BufferBuilder, Date64Array, Date64BufferBuilder, Decimal128Array, Decimal128BufferBuilder, Decimal256Array, Decimal256BufferBuilder, Float64Array, Int32Array, Int64Array, Int64BufferBuilder, RecordBatch, StringArray, Time32MillisecondArray, Time32MillisecondBufferBuilder, Time64MicrosecondArray, Time64MicrosecondBufferBuilder, TimestampMillisecondArray, TimestampMillisecondBufferBuilder};
use arrow::datatypes::{i256, DataType, Field, SchemaBuilder, TimeUnit};
use arrow::util::pretty::pretty_format_batches;
use chrono::{DateTime, Duration};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use indoc::indoc;
use pretty_assertions::assert_eq;

use crate::proto::dashql_compute::{AggregationFunction, BinningTransform, FilterOperator, FilterTransform, GroupByAggregate, GroupByKey, GroupByKeyBinning, RowNumberTransform, ValueIdentifierTransform};
use crate::proto::dashql_compute::{DataFrameTransform, OrderByConstraint, OrderByTransform, GroupByTransform};
use crate::data_frame::DataFrame;

#[tokio::test]
async fn test_transform_orderby() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("score", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
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
async fn test_transform_rownumber() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![3, 2, 1])) as ArrayRef),
        ("score", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        filters: vec![],
        row_number: Some(RowNumberTransform {
            output_alias: "rownum".to_string(),
        }),
        value_identifiers: vec![],
        binning: vec![],
        group_by: None,
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +----+-------+--------+
        | id | score | rownum |
        +----+-------+--------+
        | 3  | 9000  | 1      |
        | 2  | 8000  | 2      |
        | 1  | 7000  | 3      |
        +----+-------+--------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_value_ids() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("v1", DataType::Utf8, false));
    schema_builder.push(Field::new("v2", DataType::Utf8, false));
    let schema = schema_builder.finish();
    let data = RecordBatch::try_new(schema.into(), vec![
        Arc::new(StringArray::from(vec![
            "a1",
            "a2",
            "a3",
            "a1",
            "a2",
            "a1",
            "a4",
            "a6",
            "a0",
        ])) as ArrayRef,
        Arc::new(StringArray::from(vec![
            "b5",
            "b8",
            "b2",
            "b3",
            "b3",
            "b1",
            "b9",
            "b4",
            "b8",
        ])) as ArrayRef,
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        filters: vec![],
        row_number: Some(
            RowNumberTransform{
                output_alias: "rownum".to_string(),
            },
        ),
        value_identifiers: vec![
            ValueIdentifierTransform{
                field_name: "v1".to_string(),
                output_alias: "v1_id".to_string(),
            },
            ValueIdentifierTransform{
                field_name: "v2".to_string(),
                output_alias: "v2_id".to_string(),
            }
        ],
        binning: vec![],
        group_by: None,
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint{
                    field_name: "rownum".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        }),
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +----+----+--------+-------+-------+
        | v1 | v2 | rownum | v1_id | v2_id |
        +----+----+--------+-------+-------+
        | a1 | b5 | 1      | 2     | 5     |
        | a2 | b8 | 2      | 3     | 6     |
        | a3 | b2 | 3      | 4     | 2     |
        | a1 | b3 | 4      | 2     | 3     |
        | a2 | b3 | 5      | 3     | 3     |
        | a1 | b1 | 6      | 2     | 1     |
        | a4 | b9 | 7      | 5     | 7     |
        | a6 | b4 | 8      | 6     | 4     |
        | a0 | b8 | 9      | 1     | 6     |
        +----+----+--------+-------+-------+
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
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("score".into()),
                    output_alias: "score_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("score".into()),
                    output_alias: "score_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
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
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v1".into()),
                    output_alias: "v1_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v1".into()),
                    output_alias: "v1_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v2".into()),
                    output_alias: "v2_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v2".into()),
                    output_alias: "v2_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                }
            ]
        }),
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +----------------------------------------+----------------------------------------+----------+--------------------------------------+
        | v1_min                                 | v1_max                                 | v2_min   | v2_max                               |
        +----------------------------------------+----------------------------------------+----------+--------------------------------------+
        | 860f346a-5e02-4f32-93db-6c54378e31bb/0 | 860f346a-5e02-4f32-93db-6c54378e31bb/8 | 5f20bedd | 5f20bedd-6ee4-4df9-8cac-2d4907900012 |
        +----------------------------------------+----------------------------------------+----------+--------------------------------------+
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

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
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

    // Bin into 64 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 32,
                        output_bin_ub_alias: "bin_ub".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_width_alias: "bin_width".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
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
        +--------+----------+-----------+---------------------+---------------------+
        | ts_bin | ts_count | bin_width | bin_lb              | bin_ub              |
        +--------+----------+-----------+---------------------+---------------------+
        | 0      | 1        | PT675S    | 2024-04-01T13:00:00 | 2024-04-01T13:11:15 |
        | 1      |          | PT675S    | 2024-04-01T13:11:15 | 2024-04-01T13:22:30 |
        | 2      |          | PT675S    | 2024-04-01T13:22:30 | 2024-04-01T13:33:45 |
        | 3      |          | PT675S    | 2024-04-01T13:33:45 | 2024-04-01T13:45:00 |
        | 4      |          | PT675S    | 2024-04-01T13:45:00 | 2024-04-01T13:56:15 |
        | 5      | 3        | PT675S    | 2024-04-01T13:56:15 | 2024-04-01T14:07:30 |
        | 6      |          | PT675S    | 2024-04-01T14:07:30 | 2024-04-01T14:18:45 |
        | 7      |          | PT675S    | 2024-04-01T14:18:45 | 2024-04-01T14:30:00 |
        | 8      |          | PT675S    | 2024-04-01T14:30:00 | 2024-04-01T14:41:15 |
        | 9      |          | PT675S    | 2024-04-01T14:41:15 | 2024-04-01T14:52:30 |
        | 10     | 1        | PT675S    | 2024-04-01T14:52:30 | 2024-04-01T15:03:45 |
        | 11     |          | PT675S    | 2024-04-01T15:03:45 | 2024-04-01T15:15:00 |
        | 12     |          | PT675S    | 2024-04-01T15:15:00 | 2024-04-01T15:26:15 |
        | 13     |          | PT675S    | 2024-04-01T15:26:15 | 2024-04-01T15:37:30 |
        | 14     |          | PT675S    | 2024-04-01T15:37:30 | 2024-04-01T15:48:45 |
        | 15     |          | PT675S    | 2024-04-01T15:48:45 | 2024-04-01T16:00:00 |
        | 16     | 1        | PT675S    | 2024-04-01T16:00:00 | 2024-04-01T16:11:15 |
        | 17     |          | PT675S    | 2024-04-01T16:11:15 | 2024-04-01T16:22:30 |
        | 18     |          | PT675S    | 2024-04-01T16:22:30 | 2024-04-01T16:33:45 |
        | 19     |          | PT675S    | 2024-04-01T16:33:45 | 2024-04-01T16:45:00 |
        | 20     |          | PT675S    | 2024-04-01T16:45:00 | 2024-04-01T16:56:15 |
        | 21     | 2        | PT675S    | 2024-04-01T16:56:15 | 2024-04-01T17:07:30 |
        | 22     |          | PT675S    | 2024-04-01T17:07:30 | 2024-04-01T17:18:45 |
        | 23     |          | PT675S    | 2024-04-01T17:18:45 | 2024-04-01T17:30:00 |
        | 24     |          | PT675S    | 2024-04-01T17:30:00 | 2024-04-01T17:41:15 |
        | 25     |          | PT675S    | 2024-04-01T17:41:15 | 2024-04-01T17:52:30 |
        | 26     | 1        | PT675S    | 2024-04-01T17:52:30 | 2024-04-01T18:03:45 |
        | 27     |          | PT675S    | 2024-04-01T18:03:45 | 2024-04-01T18:15:00 |
        | 28     |          | PT675S    | 2024-04-01T18:15:00 | 2024-04-01T18:26:15 |
        | 29     |          | PT675S    | 2024-04-01T18:26:15 | 2024-04-01T18:37:30 |
        | 30     |          | PT675S    | 2024-04-01T18:37:30 | 2024-04-01T18:48:45 |
        | 31     | 1        | PT675S    | 2024-04-01T18:48:45 | 2024-04-01T19:00:00 |
        +--------+----------+-----------+---------------------+---------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
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
        +--------+----------+-----------+---------------------+---------------------+
        | ts_bin | ts_count | bin_width | bin_lb              | bin_ub              |
        +--------+----------+-----------+---------------------+---------------------+
        | 0      | 1        | PT2700S   | 2024-04-01T13:00:00 | 2024-04-01T13:45:00 |
        | 1      | 3        | PT2700S   | 2024-04-01T13:45:00 | 2024-04-01T14:30:00 |
        | 2      | 1        | PT2700S   | 2024-04-01T14:30:00 | 2024-04-01T15:15:00 |
        | 3      |          | PT2700S   | 2024-04-01T15:15:00 | 2024-04-01T16:00:00 |
        | 4      | 1        | PT2700S   | 2024-04-01T16:00:00 | 2024-04-01T16:45:00 |
        | 5      | 2        | PT2700S   | 2024-04-01T16:45:00 | 2024-04-01T17:30:00 |
        | 6      | 1        | PT2700S   | 2024-04-01T17:30:00 | 2024-04-01T18:15:00 |
        | 7      | 1        | PT2700S   | 2024-04-01T18:15:00 | 2024-04-01T19:00:00 |
        +--------+----------+-----------+---------------------+---------------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_date32() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("ts", DataType::Date32, false));
    let schema = schema_builder.finish();

    let mut ts_buf = Date32BufferBuilder::new(10);
    let mut next_ts = 0;
    for _ in 0..7 {
        next_ts += 1;
        ts_buf.append(next_ts);
    }
    ts_buf.append(3);
    ts_buf.append(3);
    ts_buf.append(5);
    let ts_array = Arc::new(Date32Array::new(ts_buf.finish().into(), None));

    let data = RecordBatch::try_new(schema.into(), vec![ts_array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +------------+------------+
        | ts_min     | ts_max     |
        +------------+------------+
        | 1970-01-02 | 1970-01-08 |
        +------------+------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
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
        +--------+----------+-----------+------------+------------+
        | ts_bin | ts_count | bin_width | bin_lb     | bin_ub     |
        +--------+----------+-----------+------------+------------+
        | 0      | 1        | PT64800S  | 1970-01-02 | 1970-01-02 |
        | 1      | 1        | PT64800S  | 1970-01-02 | 1970-01-03 |
        | 2      | 3        | PT64800S  | 1970-01-03 | 1970-01-04 |
        | 3      |          | PT64800S  | 1970-01-04 | 1970-01-05 |
        | 4      | 1        | PT64800S  | 1970-01-05 | 1970-01-05 |
        | 5      | 2        | PT64800S  | 1970-01-05 | 1970-01-06 |
        | 6      | 1        | PT64800S  | 1970-01-06 | 1970-01-07 |
        | 7      | 1        | PT64800S  | 1970-01-07 | 1970-01-08 |
        +--------+----------+-----------+------------+------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_date64() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("ts", DataType::Date64, false));
    let schema = schema_builder.finish();

    let mut ts_buf = Date64BufferBuilder::new(10);
    let ts_base = DateTime::parse_from_rfc3339("2024-04-01T12:00:00-00:00")?;
    let mut next_ts = ts_base.clone();
    for _ in 0..7 {
        next_ts += Duration::days(1);
        let ms = SystemTime::from(next_ts).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        ts_buf.append(ms);
    }
    ts_buf.append(SystemTime::from(ts_base + Duration::days(2)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64);
    ts_buf.append(SystemTime::from(ts_base + Duration::days(2)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64);
    ts_buf.append(SystemTime::from(ts_base + Duration::days(5)).duration_since(UNIX_EPOCH).unwrap().as_millis() as i64);
    let ts_array = Arc::new(Date64Array::new(ts_buf.finish().into(), None));

    let data = RecordBatch::try_new(schema.into(), vec![ts_array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
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
        | 2024-04-02T12:00:00 | 2024-04-08T12:00:00 |
        +---------------------+---------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("ts".into()),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
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
        +--------+----------+-----------+---------------------+---------------------+
        | ts_bin | ts_count | bin_width | bin_lb              | bin_ub              |
        +--------+----------+-----------+---------------------+---------------------+
        | 0      | 1        | PT64800S  | 2024-04-02T12:00:00 | 2024-04-03T06:00:00 |
        | 1      | 3        | PT64800S  | 2024-04-03T06:00:00 | 2024-04-04T00:00:00 |
        | 2      | 1        | PT64800S  | 2024-04-04T00:00:00 | 2024-04-04T18:00:00 |
        | 3      |          | PT64800S  | 2024-04-04T18:00:00 | 2024-04-05T12:00:00 |
        | 4      | 1        | PT64800S  | 2024-04-05T12:00:00 | 2024-04-06T06:00:00 |
        | 5      | 2        | PT64800S  | 2024-04-06T06:00:00 | 2024-04-07T00:00:00 |
        | 6      | 1        | PT64800S  | 2024-04-07T00:00:00 | 2024-04-07T18:00:00 |
        | 7      | 1        | PT64800S  | 2024-04-07T18:00:00 | 2024-04-08T12:00:00 |
        +--------+----------+-----------+---------------------+---------------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_time32() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("t", DataType::Time32(TimeUnit::Millisecond), false));
    let schema = schema_builder.finish();

    let mut ts_buf = Time32MillisecondBufferBuilder::new(10);
    let mut next_ts = 0;
    for _ in 0..7 {
        ts_buf.append(next_ts);
        next_ts += 1000 * 60 * 60;
    }
    ts_buf.append(1000 * 60 * 60 * 3);
    ts_buf.append(1000 * 60 * 60 * 3);
    ts_buf.append(1000 * 60 * 60 * 5);
    let ts_array = Arc::new(Time32MillisecondArray::new(ts_buf.finish().into(), None));

    let data = RecordBatch::try_new(schema.into(), vec![ts_array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("t".into()),
                    output_alias: "t_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("t".into()),
                    output_alias: "t_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +----------+----------+
        | t_min    | t_max    |
        +----------+----------+
        | 00:00:00 | 06:00:00 |
        +----------+----------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "t".into(),
                    output_alias: "t_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "t_min".into(),
                        stats_maximum_field_name: "t_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("t".into()),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "t_bin".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        })
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +-------+----------+-----------+----------+----------+
        | t_bin | ts_count | bin_width | bin_lb   | bin_ub   |
        +-------+----------+-----------+----------+----------+
        | 0     | 1        | 2700000   | 00:00:00 | 00:45:00 |
        | 1     | 1        | 2700000   | 00:45:00 | 01:30:00 |
        | 2     | 1        | 2700000   | 01:30:00 | 02:15:00 |
        | 3     |          | 2700000   | 02:15:00 | 03:00:00 |
        | 4     | 3        | 2700000   | 03:00:00 | 03:45:00 |
        | 5     | 1        | 2700000   | 03:45:00 | 04:30:00 |
        | 6     | 2        | 2700000   | 04:30:00 | 05:15:00 |
        | 7     | 1        | 2700000   | 05:15:00 | 06:00:00 |
        +-------+----------+-----------+----------+----------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_time64() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("t", DataType::Time64(TimeUnit::Microsecond), false));
    let schema = schema_builder.finish();

    let mut ts_buf = Time64MicrosecondBufferBuilder::new(10);
    let mut next_ts = 0;
    for _ in 0..7 {
        ts_buf.append(next_ts);
        next_ts += 1000 * 1000 * 60 * 60;
    }
    ts_buf.append(1000 * 1000 * 60 * 60 * 3);
    ts_buf.append(1000 * 1000 * 60 * 60 * 3);
    ts_buf.append(1000 * 1000 * 60 * 60 * 5);
    let ts_array = Arc::new(Time64MicrosecondArray::new(ts_buf.finish().into(), None));

    let data = RecordBatch::try_new(schema.into(), vec![ts_array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("t".into()),
                    output_alias: "t_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("t".into()),
                    output_alias: "t_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +----------+----------+
        | t_min    | t_max    |
        +----------+----------+
        | 00:00:00 | 06:00:00 |
        +----------+----------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "t".into(),
                    output_alias: "t_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "t_min".into(),
                        stats_maximum_field_name: "t_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("t".into()),
                    output_alias: "ts_count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "t_bin".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        })
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +-------+----------+------------+----------+----------+
        | t_bin | ts_count | bin_width  | bin_lb   | bin_ub   |
        +-------+----------+------------+----------+----------+
        | 0     | 1        | 2700000000 | 00:00:00 | 00:45:00 |
        | 1     | 1        | 2700000000 | 00:45:00 | 01:30:00 |
        | 2     | 1        | 2700000000 | 01:30:00 | 02:15:00 |
        | 3     |          | 2700000000 | 02:15:00 | 03:00:00 |
        | 4     | 3        | 2700000000 | 03:00:00 | 03:45:00 |
        | 5     | 1        | 2700000000 | 03:45:00 | 04:30:00 |
        | 6     | 2        | 2700000000 | 04:30:00 | 05:15:00 |
        | 7     | 1        | 2700000000 | 05:15:00 | 06:00:00 |
        +-------+----------+------------+----------+----------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_int64() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("v", DataType::Int64, false));
    let schema = schema_builder.finish();

    let mut buf = Int64BufferBuilder::new(10);
    let mut next_v = -1 * 1000 * 1000;
    for _ in 0..7 {
        buf.append(next_v);
        next_v += 1000 * 1000;
    }
    buf.append(1000 * 1000);
    buf.append(1000 * 1000);
    buf.append(1000 * 1000);
    let array = Arc::new(Int64Array::new(buf.finish().into(), None));

    let data = RecordBatch::try_new(schema.into(), vec![array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +----------+---------+
        | v_min    | v_max   |
        +----------+---------+
        | -1000000 | 5000000 |
        +----------+---------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "v".into(),
                    output_alias: "v_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "v_min".into(),
                        stats_maximum_field_name: "v_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "v_bin".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        })
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +-------+-------+-----------+----------+---------+
        | v_bin | count | bin_width | bin_lb   | bin_ub  |
        +-------+-------+-----------+----------+---------+
        | 0     | 1     | 750000    | -1000000 | -250000 |
        | 1     | 1     | 750000    | -250000  | 500000  |
        | 2     | 4     | 750000    | 500000   | 1250000 |
        | 3     |       | 750000    | 1250000  | 2000000 |
        | 4     | 1     | 750000    | 2000000  | 2750000 |
        | 5     | 1     | 750000    | 2750000  | 3500000 |
        | 6     | 1     | 750000    | 3500000  | 4250000 |
        | 7     | 1     | 750000    | 4250000  | 5000000 |
        +-------+-------+-----------+----------+---------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_decimal128() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("v", DataType::Decimal128(38, 18), false));
    let schema = schema_builder.finish();

    let mut buf = Decimal128BufferBuilder::new(10);
    let e17 = 5 * 10_i128.pow(17);
    let mut next_v = e17;
    for _ in 0..7 {
        buf.append(next_v);
        next_v += e17;
    }
    buf.append(2 * e17);
    buf.append(2 * e17);
    buf.append(5 * e17);
    let array = Arc::new(Decimal128Array::new(buf.finish().into(), None).with_precision_and_scale(38, 18)?);

    let data = RecordBatch::try_new(schema.into(), vec![array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +----------------------+----------------------+
        | v_min                | v_max                |
        +----------------------+----------------------+
        | 0.500000000000000000 | 3.500000000000000000 |
        +----------------------+----------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "v".into(),
                    output_alias: "v_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "v_min".into(),
                        stats_maximum_field_name: "v_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "v_bin".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        })
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +-------+-------+----------------------+----------------------+----------------------+
        | v_bin | count | bin_width            | bin_lb               | bin_ub               |
        +-------+-------+----------------------+----------------------+----------------------+
        | 0     | 1     | 0.375000000000000000 | 0.500000000000000000 | 0.875000000000000000 |
        | 1     | 3     | 0.375000000000000000 | 0.875000000000000000 | 1.250000000000000000 |
        | 2     | 1     | 0.375000000000000000 | 1.250000000000000000 | 1.625000000000000000 |
        | 3     |       | 0.375000000000000000 | 1.625000000000000000 | 2.000000000000000000 |
        | 4     | 1     | 0.375000000000000000 | 2.000000000000000000 | 2.375000000000000000 |
        | 5     | 2     | 0.375000000000000000 | 2.375000000000000000 | 2.750000000000000000 |
        | 6     | 1     | 0.375000000000000000 | 2.750000000000000000 | 3.125000000000000000 |
        | 7     | 1     | 0.375000000000000000 | 3.125000000000000000 | 3.500000000000000000 |
        +-------+-------+----------------------+----------------------+----------------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_decimal128_precomputed() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("v", DataType::Decimal128(38, 18), false));
    let schema = schema_builder.finish();

    let mut buf = Decimal128BufferBuilder::new(10);
    let e17 = 5 * 10_i128.pow(17);
    let mut next_v = e17;
    for _ in 0..7 {
        buf.append(next_v);
        next_v += e17;
    }
    buf.append(2 * e17);
    buf.append(2 * e17);
    buf.append(5 * e17);
    let array = Arc::new(Decimal128Array::new(buf.finish().into(), None).with_precision_and_scale(38, 18)?);

    let data = RecordBatch::try_new(schema.into(), vec![array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +----------------------+----------------------+
        | v_min                | v_max                |
        +----------------------+----------------------+
        | 0.500000000000000000 | 3.500000000000000000 |
        +----------------------+----------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![
            BinningTransform {
                field_name: "v".to_string(),
                stats_minimum_field_name: "v_min".to_string(),
                stats_maximum_field_name: "v_max".to_string(),
                bin_count: 8,
                output_alias: "v_bin".to_string(),
            }
        ],
        group_by: None,
        order_by: None,
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +----------------------+--------------------+
        | v                    | v_bin              |
        +----------------------+--------------------+
        | 0.500000000000000000 | 0.0                |
        | 1.000000000000000000 | 1.3333333333333333 |
        | 1.500000000000000000 | 2.6666666666666665 |
        | 2.000000000000000000 | 4.0                |
        | 2.500000000000000000 | 5.333333333333333  |
        | 3.000000000000000000 | 6.666666666666667  |
        | 3.500000000000000000 | 8.0                |
        | 1.000000000000000000 | 1.3333333333333333 |
        | 1.000000000000000000 | 1.3333333333333333 |
        | 2.500000000000000000 | 5.333333333333333  |
        +----------------------+--------------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_decimal256() -> anyhow::Result<()> {
    let mut schema_builder = SchemaBuilder::with_capacity(2);
    schema_builder.push(Field::new("v", DataType::Decimal256(38, 18), false));
    let schema = schema_builder.finish();

    let mut buf = Decimal256BufferBuilder::new(10);
    let e17 = i256::from(5) * i256::from(10).pow_wrapping(17);
    let mut next_v = e17;
    for _ in 0..7 {
        buf.append(next_v);
        next_v += e17;
    }
    buf.append(i256::from(2) * e17);
    buf.append(i256::from(2) * e17);
    buf.append(i256::from(5) * e17);
    let array = Arc::new(Decimal256Array::new(buf.finish().into(), None).with_precision_and_scale(38, 18)?);

    let data = RecordBatch::try_new(schema.into(), vec![array])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);

    // Compute statistics
    let stats_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: None,
                },
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "v_max".into(),
                    aggregation_function: AggregationFunction::Max.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: None,
    };
    let stats = data_frame.transform(&stats_transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&stats.partitions[0])?), indoc! {"
        +----------------------+----------------------+
        | v_min                | v_max                |
        +----------------------+----------------------+
        | 0.500000000000000000 | 3.500000000000000000 |
        +----------------------+----------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        filters: vec![],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "v".into(),
                    output_alias: "v_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        pre_binned_field_name: None,
                        stats_minimum_field_name: "v_min".into(),
                        stats_maximum_field_name: "v_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    }),
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: Some("v".into()),
                    output_alias: "count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: None,
                },
            ]
        }),
        order_by: Some(OrderByTransform {
            constraints: vec![
                OrderByConstraint {
                    field_name: "v_bin".into(),
                    ascending: true,
                    nulls_first: false
                }
            ],
            limit: None
        })
    };
    let binned = data_frame.transform(&bin_transform, Some(&stats)).await?;
    assert_eq!(format!("{}", pretty_format_batches(&binned.partitions[0])?), indoc! {"
        +-------+-------+----------------------+----------------------+----------------------+
        | v_bin | count | bin_width            | bin_lb               | bin_ub               |
        +-------+-------+----------------------+----------------------+----------------------+
        | 0     | 1     | 0.375000000000000000 | 0.500000000000000001 | 0.875000000000000001 |
        | 1     | 3     | 0.375000000000000000 | 0.875000000000000001 | 1.250000000000000001 |
        | 2     | 1     | 0.375000000000000000 | 1.250000000000000001 | 1.625000000000000001 |
        | 3     |       | 0.375000000000000000 | 1.625000000000000001 | 2.000000000000000001 |
        | 4     | 1     | 0.375000000000000000 | 2.000000000000000001 | 2.375000000000000001 |
        | 5     | 2     | 0.375000000000000000 | 2.375000000000000001 | 2.750000000000000001 |
        | 6     | 1     | 0.375000000000000000 | 2.750000000000000001 | 3.125000000000000001 |
        | 7     | 1     | 0.375000000000000000 | 3.125000000000000001 | 3.500000000000000001 |
        +-------+-------+----------------------+----------------------+----------------------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_filters_1() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("value", Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])) as ArrayRef),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        filters: vec![FilterTransform {
            field_name: "value".to_string(),
            operator: FilterOperator::LessThan.into(),
            value_double: Some(2.0),
            join_field_name: None,
        }],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: None,
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +-------+
        | value |
        +-------+
        | 1.0   |
        +-------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_filters_2() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("value", Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])) as ArrayRef),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
        filters: vec![FilterTransform {
            field_name: "value".to_string(),
            operator: FilterOperator::GreaterThan.into(),
            value_double: Some(1.0),
            join_field_name: None,
        }, FilterTransform {
            field_name: "value".to_string(),
            operator: FilterOperator::LessEqual.into(),
            value_double: Some(3.0),
            join_field_name: None,
        }],
        row_number: None,
        value_identifiers: vec![],
        binning: vec![],
        group_by: None,
        order_by: None,
    };
    let transformed = data_frame.transform(&transform, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&transformed.partitions[0])?), indoc! {"
        +-------+
        | value |
        +-------+
        | 2.0   |
        | 3.0   |
        +-------+
    "}.trim());
    Ok(())
}
