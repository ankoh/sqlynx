use arrow::array::{ArrayRef, Int32Array, Int64Array, RecordBatch, StringArray};
use arrow::datatypes::{Field, SchemaBuilder, DataType};
use arrow::util::pretty::pretty_format_batches;
use std::sync::Arc;
use indoc::indoc;
use pretty_assertions::assert_eq;

use crate::proto::sqlynx_compute::{AggregationFunction, GroupByAggregate};
use crate::{data_frame::DataFrame, proto::sqlynx_compute::{DataFrameTransform, OrderByConstraint, OrderByTransform, GroupByTransform}};

#[tokio::test]
async fn test_transform_orderby() -> anyhow::Result<()> {
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("score", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;
    let data_frame = DataFrame::new(data.schema(), vec![data]);
    let transform = DataFrameTransform {
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
        group_by: None,
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
        order_by: None,
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
async fn test_minmax_string() -> anyhow::Result<()> {
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
        order_by: None,
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
