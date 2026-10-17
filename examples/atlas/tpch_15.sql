-- @dashql:description
-- Finds the top-revenue supplier(s) for the first quarter of 1996 (January through March), where
-- revenue is the sum of line item extended price net of discount for items shipped in that period.
-- It returns the supplier's key, name, address, phone and total revenue, including all suppliers
-- tied for the maximum.
--
-- Example questions:
-- - Which supplier generated the most revenue in Q1 1996?
-- - Who was the top supplier by shipped revenue between January and March 1996?
-- - Show the name, address, phone and total revenue of the best-performing supplier for a given
--   quarter
-- - How do I find the supplier with maximum discounted line item revenue in a three-month window?
-- - Which suppliers are tied for highest quarterly revenue in TPC-H?
-- @dashql:end

with
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    revenue as (
        select l_suppkey as supplier_no, sum(l_extendedprice * (1 - l_discount)) as total_revenue
        from lineitem
        where l_shipdate >= date '1996-01-01' and l_shipdate < date '1996-04-01'
        group by l_suppkey
    )
select s_suppkey, s_name, s_address, s_phone, total_revenue
from supplier, revenue
where s_suppkey = supplier_no and total_revenue = (select max(total_revenue) from revenue)
order by s_suppkey;
