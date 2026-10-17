-- @dashql:description
-- For each combination of part brand, type and size, counts how many distinct suppliers can supply
-- such parts (TPC-H parts/supplier relationship query). It only includes parts that are not
-- Brand#45, whose type does not start with "MEDIUM POLISHED", and whose size is one of 49, 14, 23,
-- 45, 19, 3, 36 or 9, and it excludes suppliers whose comments mention Customer Complaints. Results
-- are ordered by supplier count descending, then brand, type and size.
--
-- Example questions:
-- - How many distinct suppliers are available for each part brand, type and size?
-- - Which part brand/type/size combinations have the most suppliers, excluding suppliers with
--   customer complaints?
-- - Show the TPC-H parts/supplier relationship query (Q16) on the 0.01 scale factor data
-- - Count suppliers per part type and size, excluding Brand#45 and MEDIUM POLISHED types
-- - Which suppliers with complaint comments should be excluded when counting supply options for
--   selected part sizes?
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    partsupp as (select * from external('https://data.dashql.app/tpch-0.001/v1/partsupp.parquet'))
select p_brand, p_type, p_size, count(distinct ps_suppkey) as supplier_cnt
from partsupp, part
where p_partkey = ps_partkey and p_brand <> 'Brand#45' and p_type not like 'MEDIUM POLISHED%' and p_size in (49, 14, 23, 45, 19, 3, 36, 9)
    and ps_suppkey not in (select s_suppkey from supplier where s_comment like '%Customer%Complaints%')
group by p_brand, p_type, p_size
order by supplier_cnt desc, p_brand, p_type, p_size;
