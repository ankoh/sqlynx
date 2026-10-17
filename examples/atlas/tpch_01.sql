-- @dashql:description
-- Pricing summary report over TPC-H lineitem data for items shipped on or before 90 days before
-- 1998-12-01 (1998-09-02). For each return flag and line status combination, it reports total and
-- average quantity, base price, discounted price, charge including tax, average discount, and
-- number of line items.
--
-- Example questions:
-- - What are the total quantities and prices by return flag and line status for shipped line items?
-- - Show me a TPC-H pricing summary report with discounted price and charge totals
-- - How many line items are there per return flag and line status up to 90 days before the end of
--   1998?
-- - What are the average quantity, price and discount per return flag and line status?
-- - How do I compute revenue after discount and tax grouped by return flag and line status?
-- @dashql:end

with
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet'))
select l_returnflag, l_linestatus, sum(l_quantity) as sum_qty, sum(l_extendedprice) as sum_base_price,
    sum(l_extendedprice * (1 - l_discount)) as sum_disc_price, sum(l_extendedprice * (1 - l_discount) * (1 + l_tax)) as sum_charge,
    avg(l_quantity) as avg_qty, avg(l_extendedprice) as avg_price, avg(l_discount) as avg_disc, count(*) as count_order
from lineitem
where l_shipdate <= date '1998-12-01' - interval '90' day
group by l_returnflag, l_linestatus
order by l_returnflag, l_linestatus;
