-- @dashql:description
-- Estimates the average yearly revenue that would be lost if small orders were no longer filled,
-- for parts of Brand#23 in MED BOX containers (TPC-H small-quantity-order revenue query). It sums
-- the extended price of line items whose quantity is below 20% of the average quantity ordered for
-- the same part, then divides by 7 years.
--
-- Example questions:
-- - What is the average yearly revenue lost if we stop filling small orders for Brand#23 parts in
--   MED BOX containers?
-- - How much revenue comes from line items with quantity below 20% of the part's average quantity?
-- - Run the TPC-H small-quantity-order revenue query (Q17) on part and lineitem data.
-- - Sum extended price for small-quantity line items of a specific brand and container, divided by
--   seven years.
-- - Which correlated subquery example compares line item quantity to the average quantity per part?
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select sum(l_extendedprice) / 7.0 as avg_yearly
from lineitem, part
where p_partkey = l_partkey and p_brand = 'Brand#23' and p_container = 'MED BOX'
    and l_quantity < (select 0.2 * avg(l_quantity) from lineitem where l_partkey = p_partkey);
