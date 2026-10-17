-- @dashql:description
-- Finds large-volume orders, meaning orders whose total line-item quantity exceeds 300 units, and
-- shows the customer who placed each one with order key, order date, total price and total
-- quantity. This is the TPC-H "large volume customer" query, run on the scale 0.01 data. Results
-- are sorted by order total price descending, then by order date, and limited to the top 100.
--
-- Example questions:
-- - Which orders have a total quantity above 300 units, and which customers placed them?
-- - Show the top 100 most expensive large-volume orders with customer name and order date.
-- - Who are the large volume customers in TPC-H?
-- - List orders whose summed line item quantity exceeds 300, sorted by total price.
-- - What is the total quantity per order for big orders, along with customer key and order price?
-- @dashql:end

with
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice, sum(l_quantity)
from customer, orders, lineitem
where o_orderkey in (select l_orderkey from lineitem group by l_orderkey having sum(l_quantity) > 300) and c_custkey = o_custkey
    and o_orderkey = l_orderkey
group by c_name, c_custkey, o_orderkey, o_orderdate, o_totalprice
order by o_totalprice desc, o_orderdate
limit 100;
