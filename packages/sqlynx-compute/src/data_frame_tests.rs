use arrow::array::{ArrayRef, Int32Array, Int64Array, RecordBatch};
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
    let order_by = DataFrameTransform {
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
    let ordered = data_frame.transform(&order_by, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&ordered.partitions[0])?), indoc! {"
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
    let order_by = DataFrameTransform {
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
    let ordered = data_frame.transform(&order_by, None).await?;
    assert_eq!(format!("{}", pretty_format_batches(&ordered.partitions[0])?), indoc! {"
        +-----------+-----------+
        | score_min | score_max |
        +-----------+-----------+
        | 7000      | 9000      |
        +-----------+-----------+
    "}.trim());
    Ok(())
}
