use arrow::array::{ArrayRef, Date32Array, Date32BufferBuilder, Date64Array, Date64BufferBuilder, Decimal128Array, Decimal128BufferBuilder, Float32Builder, Int32Array, Int64Array, Int64BufferBuilder, ListBuilder, RecordBatch, StringArray, Time32MillisecondArray, Time32MillisecondBufferBuilder, Time64MicrosecondArray, Time64MicrosecondBufferBuilder, TimestampMillisecondArray, TimestampMillisecondBufferBuilder};
use arrow::datatypes::{Field, SchemaBuilder, DataType, TimeUnit};
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

    // Compute statistics
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

    // Bin into 64 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 64,
                        output_bin_ub_alias: "bin_ub".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_width_alias: "bin_width".into(),
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
        +--------+----------+-----------+-------------------------+-------------------------+
        | ts_bin | ts_count | bin_width | bin_lb                  | bin_ub                  |
        +--------+----------+-----------+-------------------------+-------------------------+
        | 0      | 1        | PT337.5S  | 2024-04-01T13:00:00     | 2024-04-01T13:05:37.500 |
        | 10     | 3        | PT337.5S  | 2024-04-01T13:56:15     | 2024-04-01T14:01:52.500 |
        | 21     | 1        | PT337.5S  | 2024-04-01T14:58:07.500 | 2024-04-01T15:03:45     |
        | 32     | 1        | PT337.5S  | 2024-04-01T16:00:00     | 2024-04-01T16:05:37.500 |
        | 42     | 2        | PT337.5S  | 2024-04-01T16:56:15     | 2024-04-01T17:01:52.500 |
        | 53     | 1        | PT337.5S  | 2024-04-01T17:58:07.500 | 2024-04-01T18:03:45     |
        | 64     | 1        | PT337.5S  | 2024-04-01T19:00:00     | 2024-04-01T19:05:37.500 |
        +--------+----------+-----------+-------------------------+-------------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
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
        +--------+----------+-----------+---------------------+---------------------+
        | ts_bin | ts_count | bin_width | bin_lb              | bin_ub              |
        +--------+----------+-----------+---------------------+---------------------+
        | 0      | 1        | PT2700S   | 2024-04-01T13:00:00 | 2024-04-01T13:45:00 |
        | 1      | 3        | PT2700S   | 2024-04-01T13:45:00 | 2024-04-01T14:30:00 |
        | 2      | 1        | PT2700S   | 2024-04-01T14:30:00 | 2024-04-01T15:15:00 |
        | 4      | 1        | PT2700S   | 2024-04-01T16:00:00 | 2024-04-01T16:45:00 |
        | 5      | 2        | PT2700S   | 2024-04-01T16:45:00 | 2024-04-01T17:30:00 |
        | 6      | 1        | PT2700S   | 2024-04-01T17:30:00 | 2024-04-01T18:15:00 |
        | 8      | 1        | PT2700S   | 2024-04-01T19:00:00 | 2024-04-01T19:45:00 |
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
        +------------+------------+
        | ts_min     | ts_max     |
        +------------+------------+
        | 1970-01-02 | 1970-01-08 |
        +------------+------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
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
        +--------+----------+-----------+------------+------------+
        | ts_bin | ts_count | bin_width | bin_lb     | bin_ub     |
        +--------+----------+-----------+------------+------------+
        | 0      | 1        | PT64800S  | 1970-01-02 | 1970-01-02 |
        | 1      | 1        | PT64800S  | 1970-01-02 | 1970-01-03 |
        | 2      | 3        | PT64800S  | 1970-01-03 | 1970-01-04 |
        | 4      | 1        | PT64800S  | 1970-01-05 | 1970-01-05 |
        | 5      | 2        | PT64800S  | 1970-01-05 | 1970-01-06 |
        | 6      | 1        | PT64800S  | 1970-01-06 | 1970-01-07 |
        | 8      | 1        | PT64800S  | 1970-01-08 | 1970-01-08 |
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
        | 2024-04-02T12:00:00 | 2024-04-08T12:00:00 |
        +---------------------+---------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "ts".into(),
                    output_alias: "ts_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "ts_min".into(),
                        stats_maximum_field_name: "ts_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
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
        +--------+----------+-----------+---------------------+---------------------+
        | ts_bin | ts_count | bin_width | bin_lb              | bin_ub              |
        +--------+----------+-----------+---------------------+---------------------+
        | 0      | 1        | PT64800S  | 2024-04-02T12:00:00 | 2024-04-03T06:00:00 |
        | 1      | 3        | PT64800S  | 2024-04-03T06:00:00 | 2024-04-04T00:00:00 |
        | 2      | 1        | PT64800S  | 2024-04-04T00:00:00 | 2024-04-04T18:00:00 |
        | 4      | 1        | PT64800S  | 2024-04-05T12:00:00 | 2024-04-06T06:00:00 |
        | 5      | 2        | PT64800S  | 2024-04-06T06:00:00 | 2024-04-07T00:00:00 |
        | 6      | 1        | PT64800S  | 2024-04-07T00:00:00 | 2024-04-07T18:00:00 |
        | 8      | 1        | PT64800S  | 2024-04-08T12:00:00 | 2024-04-09T06:00:00 |
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
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "t".into(),
                    output_alias: "t_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "t".into(),
                    output_alias: "t_max".into(),
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
        +----------+----------+
        | t_min    | t_max    |
        +----------+----------+
        | 00:00:00 | 06:00:00 |
        +----------+----------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "t".into(),
                    output_alias: "t_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "t_min".into(),
                        stats_maximum_field_name: "t_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    })
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "t".into(),
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
        | 4     | 3        | 2700000   | 03:00:00 | 03:45:00 |
        | 5     | 1        | 2700000   | 03:45:00 | 04:30:00 |
        | 6     | 2        | 2700000   | 04:30:00 | 05:15:00 |
        | 8     | 1        | 2700000   | 06:00:00 | 06:45:00 |
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
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "t".into(),
                    output_alias: "t_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "t".into(),
                    output_alias: "t_max".into(),
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
        +----------+----------+
        | t_min    | t_max    |
        +----------+----------+
        | 00:00:00 | 06:00:00 |
        +----------+----------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "t".into(),
                    output_alias: "t_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "t_min".into(),
                        stats_maximum_field_name: "t_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    })
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "t".into(),
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
        | 4     | 3        | 2700000000 | 03:00:00 | 03:45:00 |
        | 5     | 1        | 2700000000 | 03:45:00 | 04:30:00 |
        | 6     | 2        | 2700000000 | 04:30:00 | 05:15:00 |
        | 8     | 1        | 2700000000 | 06:00:00 | 06:45:00 |
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
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "v".into(),
                    output_alias: "v_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "v".into(),
                    output_alias: "v_max".into(),
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
        +----------+---------+
        | v_min    | v_max   |
        +----------+---------+
        | -1000000 | 5000000 |
        +----------+---------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "v".into(),
                    output_alias: "v_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "v_min".into(),
                        stats_maximum_field_name: "v_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    })
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "v".into(),
                    output_alias: "count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
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
        | 4     | 1     | 750000    | 2000000  | 2750000 |
        | 5     | 1     | 750000    | 2750000  | 3500000 |
        | 6     | 1     | 750000    | 3500000  | 4250000 |
        | 8     | 1     | 750000    | 5000000  | 5750000 |
        +-------+-------+-----------+----------+---------+
    "}.trim());
    Ok(())
}

#[tokio::test]
async fn test_transform_bin_decimal_38_18() -> anyhow::Result<()> {
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
        group_by: Some(GroupByTransform {
            keys: vec![],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "v".into(),
                    output_alias: "v_min".into(),
                    aggregation_function: AggregationFunction::Min.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: true
                },
                GroupByAggregate {
                    field_name: "v".into(),
                    output_alias: "v_max".into(),
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
        +----------------------+----------------------+
        | v_min                | v_max                |
        +----------------------+----------------------+
        | 0.500000000000000000 | 3.500000000000000000 |
        +----------------------+----------------------+
    "}.trim());

    // Bin into 8 bins
    let bin_transform = DataFrameTransform {
        group_by: Some(GroupByTransform {
            keys: vec![
                GroupByKey {
                    field_name: "v".into(),
                    output_alias: "v_bin".into(),
                    binning: Some(GroupByKeyBinning {
                        stats_minimum_field_name: "v_min".into(),
                        stats_maximum_field_name: "v_max".into(),
                        bin_count: 8,
                        output_bin_width_alias: "bin_width".into(),
                        output_bin_lb_alias: "bin_lb".into(),
                        output_bin_ub_alias: "bin_ub".into(),
                    })
                }
            ],
            aggregates: vec![
                GroupByAggregate {
                    field_name: "v".into(),
                    output_alias: "count".into(),
                    aggregation_function: AggregationFunction::CountStar.into(),
                    aggregate_distinct: false,
                    aggregate_lengths: false
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
        | 3     | 1     | 0.375000000000000000 | 1.625000000000000000 | 2.000000000000000000 |
        | 4     | 1     | 0.375000000000000000 | 2.000000000000000000 | 2.375000000000000000 |
        | 5     | 2     | 0.375000000000000000 | 2.375000000000000000 | 2.750000000000000000 |
        | 7     | 1     | 0.375000000000000000 | 3.125000000000000000 | 3.500000000000000000 |
        | 8     | 1     | 0.375000000000000000 | 3.500000000000000000 | 3.875000000000000000 |
        +-------+-------+----------------------+----------------------+----------------------+
    "}.trim());
    Ok(())
}
