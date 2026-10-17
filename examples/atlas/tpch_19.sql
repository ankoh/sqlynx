-- @dashql:description
-- Computes total discounted revenue (extended price after discount) from TPC-H line items that
-- match one of three part-bundle criteria. Each bundle combines a part brand (Brand#12, #23, #34),
-- a size-matched container group (small, medium, large), a quantity range, and a size limit. All
-- must be shipped by AIR or AIR REG and delivered in person. Returns a single revenue figure.
--
-- Example questions:
-- - What is the total discounted revenue for air-shipped, deliver-in-person orders of Brand#12,
--   Brand#23 and Brand#34 parts?
-- - How much revenue comes from small, medium and large container parts within specific quantity
--   ranges?
-- - Compute the TPC-H discounted revenue query for parts by brand, container type, size and
--   quantity
-- - What is the revenue from line items shipped by AIR or AIR REG with DELIVER IN PERSON
--   instructions?
-- - Sum extended price times one minus discount for line items joined to parts matching
--   brand-specific conditions
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select sum(l_extendedprice * (1 - l_discount)) as revenue
from lineitem, part
where p_partkey = l_partkey and p_brand = 'Brand#12' and p_container in ('SM CASE', 'SM BOX', 'SM PACK', 'SM PKG') and l_quantity >= 1
        and l_quantity <= 1 + 10 and p_size between 1 and 5 and l_shipmode in ('AIR', 'AIR REG') and l_shipinstruct = 'DELIVER IN PERSON'
    or p_partkey = l_partkey and p_brand = 'Brand#23' and p_container in ('MED BAG', 'MED BOX', 'MED PKG', 'MED PACK') and l_quantity >= 10
        and l_quantity <= 10 + 10 and p_size between 1 and 10 and l_shipmode in ('AIR', 'AIR REG') and l_shipinstruct = 'DELIVER IN PERSON'
    or p_partkey = l_partkey and p_brand = 'Brand#34' and p_container in ('LG CASE', 'LG BOX', 'LG PACK', 'LG PKG') and l_quantity >= 20
        and l_quantity <= 20 + 10 and p_size between 1 and 15 and l_shipmode in ('AIR', 'AIR REG') and l_shipinstruct = 'DELIVER IN PERSON';
