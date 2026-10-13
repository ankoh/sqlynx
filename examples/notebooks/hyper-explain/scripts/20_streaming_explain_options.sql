explain (
    FORMAT SQL,
    SQL_DIALECT INTERNAL_SPARK,
    STREAMING_TABLE orders,
    CHANGE_DATA_FEED orders_cdf,
    STREAMING_KEY_COLUMNS (o_orderkey),
    STREAMING_ACTIONS_COLUMN _action,
    CHANGE_DATA_FEED_RECORD_TYPE_COLUMN _record_type,
    CHANGE_DATA_FEED_COLUMNS descriptor(_record_type TEXT)
)
select o_orderkey, o_orderstatus
from orders o;
