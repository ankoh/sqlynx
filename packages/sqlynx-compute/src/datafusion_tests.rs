use std::sync::Arc;

use arrow::array::{ArrayRef, Int32Array, RecordBatch};
use datafusion::prelude::*;


#[tokio::test]
async fn test_evaluate() -> anyhow::Result<()> {
    let ctx = SessionContext::new();

    // Register an in-memory table containing the following data
    // id | bank_account
    // ---|-------------
    // 1  | 9000
    // 2  | 8000
    // 3  | 7000
    let data = RecordBatch::try_from_iter(vec![
        ("id", Arc::new(Int32Array::from(vec![1, 2, 3])) as ArrayRef),
        ("bank_account", Arc::new(Int32Array::from(vec![9000, 8000, 7000]))),
    ])?;

    // Create a DataFrame that scans the user table, and finds
    // all users with a bank account at least 8000
    // and sorts the results by bank account in descending order
    let dataframe = ctx
        .read_batch(data)?
        .filter(col("bank_account").gt_eq(lit(8000)))? // bank_account >= 8000
        .sort(vec![col("bank_account").sort(false, true)])?; // ORDER BY bank_account DESC

    dataframe.show().await?;

    Ok(())
}
