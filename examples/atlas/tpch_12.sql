-- @dashql:description
-- For MAIL and SHIP shipping modes, counts the line items that belong to high-priority orders
-- (URGENT or HIGH) versus all other priorities. It only includes lines received during 1994 that
-- were committed before receipt and shipped before their commit date, i.e. a TPC-H shipping modes
-- and order priority analysis.
--
-- Example questions:
-- - How many high-priority versus low-priority line items were shipped by MAIL and SHIP in 1994?
-- - Break down late-received lineitems by ship mode and order priority
-- - Which orders with URGENT or HIGH priority had lines shipped before commit date but received
--   after commit date?
-- - TPC-H shipping modes and order priority query for MAIL and SHIP
-- - Compare high and low priority line counts per ship mode for 1994 receipts
-- @dashql:end

with
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select l_shipmode, sum(case when o_orderpriority = '1-URGENT' or o_orderpriority = '2-HIGH' then 1 else 0 end) as high_line_count,
    sum(case when o_orderpriority <> '1-URGENT' and o_orderpriority <> '2-HIGH' then 1 else 0 end) as low_line_count
from orders, lineitem
where o_orderkey = l_orderkey and l_shipmode in ('MAIL', 'SHIP') and l_commitdate < l_receiptdate and l_shipdate < l_commitdate
    and l_receiptdate >= date '1994-01-01' and l_receiptdate < date '1995-01-01'
group by l_shipmode
order by l_shipmode;
