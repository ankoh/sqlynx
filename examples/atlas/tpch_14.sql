-- @dashql:description
-- Computes the percentage of total revenue that came from promotional parts (part type starting
-- with 'PROMO') for line items shipped in September 1995. Revenue is extended price net of
-- discount, joining line items to parts, and the result is a single promo revenue percentage (TPC-H
-- style).
--
-- Example questions:
-- - What share of September 1995 revenue came from promotional parts?
-- - Calculate the promo revenue percentage for shipments in a given month
-- - How much of our discounted line item revenue is from PROMO part types?
-- - What is the promotion revenue ratio for items shipped between 1995-09-01 and 1995-10-01?
-- - Show promo vs. total revenue for lineitems joined with parts in one month
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select 100.00 * sum(case when p_type like 'PROMO%' then l_extendedprice * (1 - l_discount) else 0 end) / sum(l_extendedprice * (1 - l_discount)) as promo_revenue
from lineitem, part
where l_partkey = p_partkey and l_shipdate >= date '1995-09-01' and l_shipdate < date '1995-10-01';
