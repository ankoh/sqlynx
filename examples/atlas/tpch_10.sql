-- @dashql:description
-- Finds the 20 customers who lost the most revenue to returned items on orders placed in Q4 1993
-- (October through December). Revenue is the sum of extended price after discount on lineitems with
-- return flag 'R', and results show customer name, account balance, nation, address, phone and
-- comment, ranked from highest to lowest lost revenue (TPC-H Q10 style).
--
-- Example questions:
-- - Which customers had the highest revenue from returned items in Q4 1993?
-- - Show the top 20 customers by returned-item revenue for orders between October 1 and December
--   31, 1993
-- - Who are the biggest returners, with their nation, phone and account balance?
-- - TPC-H returned item reporting query: top customers by lost revenue
-- - How much discounted revenue was tied to returned lineitems per customer in late 1993?
-- @dashql:end

with
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet'))
select c_custkey, c_name, sum(l_extendedprice * (1 - l_discount)) as revenue, c_acctbal, n_name, c_address, c_phone, c_comment
from customer, orders, lineitem, nation
where c_custkey = o_custkey and l_orderkey = o_orderkey and o_orderdate >= date '1993-10-01' and o_orderdate < date '1994-01-01' and l_returnflag = 'R'
    and c_nationkey = n_nationkey
group by c_custkey, c_name, c_acctbal, c_phone, n_name, c_address, c_comment
order by revenue desc
limit 20;
