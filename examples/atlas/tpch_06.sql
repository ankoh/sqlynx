-- @dashql:description
-- Computes the total potential revenue increase from discounts (extended price times discount) on
-- line items shipped during 1994 with a discount between 5% and 7% and a quantity under 24. It is
-- the TPC-H Q6 forecasting revenue change query, run on the small-scale (0.01) lineitem Parquet
-- data.
--
-- Example questions:
-- - What revenue would we have gained by eliminating small discounts on 1994 shipments?
-- - Total of extended price times discount for line items shipped in 1994 with 5-7% discount and
--   quantity under 24
-- - Run TPC-H Query 6 forecasting revenue change on the lineitem table
-- - How much revenue is tied to discounts around 6% on low-quantity orders shipped in 1994?
-- - Example of querying a remote lineitem Parquet file with a filtered sum
-- @dashql:end

with
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select sum(l_extendedprice * l_discount) as revenue
from lineitem
where l_shipdate >= date '1994-01-01' and l_shipdate < date '1995-01-01' and l_discount between 0.06 - 0.01 and 0.06 + 0.01 and l_quantity < 24;
