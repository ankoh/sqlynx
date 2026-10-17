-- @dashql:description
-- Finds the top 10 unshipped orders by potential revenue for customers in the BUILDING market
-- segment (TPC-H shipping priority query). It considers orders placed before 15 March 1995 that
-- have line items shipped after that date, and sums discounted line item revenue per order. Results
-- show order key, revenue, order date and ship priority, sorted by highest revenue and then
-- earliest order date.
--
-- Example questions:
-- - What are the top 10 highest-revenue orders still unshipped as of March 15, 1995 for the
--   BUILDING segment?
-- - Which BUILDING market segment orders have the most potential revenue from items shipping after
--   1995-03-15?
-- - Show the TPC-H shipping priority query with order revenue, order date and ship priority.
-- - How do I compute discounted revenue per order by joining customer, orders and lineitem?
-- - List the biggest open orders by revenue placed before mid-March 1995.
-- @dashql:end

with
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select l_orderkey, sum(l_extendedprice * (1 - l_discount)) as revenue, o_orderdate, o_shippriority
from customer, orders, lineitem
where c_mktsegment = 'BUILDING' and c_custkey = o_custkey and l_orderkey = o_orderkey and o_orderdate < date '1995-03-15'
    and l_shipdate > date '1995-03-15'
group by l_orderkey, o_orderdate, o_shippriority
order by revenue desc, o_orderdate
limit 10;
