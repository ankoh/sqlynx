-- @dashql:description
-- Finds the Saudi Arabian suppliers that most often held up multi-supplier orders (TPC-H "suppliers
-- who kept orders waiting" query). It counts, per supplier, line items on finalized ('F') orders
-- that were received after their commit date, where at least one other supplier was on the order
-- and none of those other suppliers were late. Results are ranked by wait count descending, then
-- name, and limited to the top 100.
--
-- Example questions:
-- - Which Saudi Arabian suppliers kept orders waiting the most?
-- - Show suppliers in SAUDI ARABIA who were the only late supplier on multi-supplier finalized
--   orders
-- - Count late line items per supplier where all other suppliers on the order delivered on time
-- - TPC-H query 21 suppliers who kept orders waiting
-- - Top 100 suppliers by number of delayed shipments on orders with status F
-- @dashql:end

with
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet'))
select s_name, count(*) as numwait
from supplier, lineitem l1, orders, nation
where s_suppkey = l1.l_suppkey and o_orderkey = l1.l_orderkey and o_orderstatus = 'F' and l1.l_receiptdate > l1.l_commitdate
    and exists (select * from lineitem l2 where l2.l_orderkey = l1.l_orderkey and l2.l_suppkey <> l1.l_suppkey)
    and not exists (
        select * from lineitem l3 where l3.l_orderkey = l1.l_orderkey and l3.l_suppkey <> l1.l_suppkey and l3.l_receiptdate > l3.l_commitdate
    ) and s_nationkey = n_nationkey and n_name = 'SAUDI ARABIA'
group by s_name
order by numwait desc, s_name
limit 100;
