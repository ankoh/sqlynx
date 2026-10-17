-- @dashql:description
-- Identifies the most valuable parts held in stock by suppliers in Germany, based on inventory
-- value (supply cost times available quantity) per part. It keeps only parts whose total value
-- exceeds 0.01% of the total German stock value, and lists them from highest to lowest value (TPC-H
-- Important Stock Identification query).
--
-- Example questions:
-- - Which parts have the highest inventory value among German suppliers?
-- - Show parts whose stock value is more than 0.01% of Germany's total supplier stock value
-- - List significant part stock values for suppliers in GERMANY, sorted descending
-- - How do I compute supply cost times available quantity per part for a specific nation with a
--   threshold filter?
-- - TPC-H important stock identification query for Germany
-- @dashql:end

with
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    partsupp as (select * from external('https://data.dashql.app/tpch-0.001/v1/partsupp.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet'))
select ps_partkey, sum(ps_supplycost * ps_availqty) as "value"
from partsupp, supplier, nation
where ps_suppkey = s_suppkey and s_nationkey = n_nationkey and n_name = 'GERMANY'
group by ps_partkey
having sum(ps_supplycost * ps_availqty) > (
        select sum(ps_supplycost * ps_availqty) * 0.0001
        from partsupp, supplier, nation
        where ps_suppkey = s_suppkey and s_nationkey = n_nationkey and n_name = 'GERMANY'
    )
order by "value" desc;
