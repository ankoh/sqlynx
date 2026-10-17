-- @dashql:description
-- Computes 1994 revenue for each nation in the ASIA region, where revenue is line item extended
-- price net of discount. It counts only orders placed in 1994 in which the customer and the
-- supplying supplier are in the same nation. Results are ranked from highest to lowest revenue
-- (TPC-H style local supplier volume query).
--
-- Example questions:
-- - Which Asian nations had the highest revenue in 1994?
-- - What is the discounted sales revenue by nation for ASIA where customer and supplier are in the
--   same country?
-- - Show local supplier volume for the Asia region in 1994, ranked by revenue
-- - How much revenue came from orders where customers bought from suppliers in their own nation, by
--   Asian nation?
-- - Rank nations in ASIA by sum of extended price after discount for 1994 orders
-- @dashql:end

with
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet')),
    region as (select * from external('https://data.dashql.app/tpch-0.001/v1/region.parquet'))
select n_name, sum(l_extendedprice * (1 - l_discount)) as revenue
from customer, orders, lineitem, supplier, nation, region
where c_custkey = o_custkey and l_orderkey = o_orderkey and l_suppkey = s_suppkey and c_nationkey = s_nationkey and s_nationkey = n_nationkey
    and n_regionkey = r_regionkey and r_name = 'ASIA' and o_orderdate >= date '1994-01-01' and o_orderdate < date '1995-01-01'
group by n_name
order by revenue desc;
