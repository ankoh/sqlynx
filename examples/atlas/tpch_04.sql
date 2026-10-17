-- @dashql:description
-- Counts orders placed in the third quarter of 1993 (July through September) that had at least one
-- line item committed earlier than it was received, i.e. delivered late relative to the commit
-- date. Results are grouped by order priority and sorted by priority. This is the TPC-H order
-- priority checking query run on the small-scale (0.01) dataset.
--
-- Example questions:
-- - How many orders in Q3 1993 had late-received line items, by order priority?
-- - Show order counts per priority for orders with at least one line item received after its commit
--   date.
-- - Which order priorities have the most delayed orders between July and September 1993?
-- - Run the TPC-H order priority checking query.
-- - Count orders with late deliveries by priority for a given quarter.
-- @dashql:end

with
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select o_orderpriority, count(*) as order_count
from orders
where o_orderdate >= date '1993-07-01' and o_orderdate < date '1993-10-01'
    and exists (select * from lineitem where l_orderkey = o_orderkey and l_commitdate < l_receiptdate)
group by o_orderpriority
order by o_orderpriority;
