-- @dashql:description
-- Shows the distribution of customers by how many orders they have placed, excluding orders whose
-- comments mention "special" followed by "requests". For each order count (including zero for
-- customers with no qualifying orders), it returns the number of customers, sorted from the most
-- common count to the least.
--
-- Example questions:
-- - How many customers have placed each number of orders?
-- - What is the customer distribution by order count, excluding orders with special requests
--   comments?
-- - How many customers have no orders at all?
-- - Show the number of customers per order count, sorted by the most common first.
-- - What is the TPC-H customer order count distribution query?
-- @dashql:end

with
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet'))
select c_count, count(*) as custdist
from (
    select c_custkey, count(o_orderkey) as c_count
    from customer left join orders on c_custkey = o_custkey and o_comment not like '%special%requests%'
    group by c_custkey
) c_orders
group by c_count
order by custdist desc, c_count desc;
