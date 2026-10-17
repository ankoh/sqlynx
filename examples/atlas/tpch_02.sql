-- @dashql:description
-- Finds the minimum-cost suppliers in the EUROPE region for parts of size 15 whose type ends in
-- BRASS (TPC-H minimum cost supplier query). For each part it returns only suppliers offering the
-- lowest supply cost among European suppliers, with supplier account balance, name, nation,
-- address, phone and comment plus part key and manufacturer. Results are sorted by account balance
-- descending, then nation, supplier name and part key, limited to the top 100.
--
-- Example questions:
-- - Which European suppliers offer the lowest supply cost for size 15 BRASS parts?
-- - Show the cheapest suppliers in the EUROPE region for each brass part of size 15
-- - TPC-H minimum cost supplier query: top 100 suppliers by account balance
-- - Which suppliers in Europe have the minimum ps_supplycost per part, with their nation and
--   contact details?
-- - List supplier balance, name, nation, and part manufacturer for the lowest-cost brass part
--   offers in Europe
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    partsupp as (select * from external('https://data.dashql.app/tpch-0.001/v1/partsupp.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet')),
    region as (select * from external('https://data.dashql.app/tpch-0.001/v1/region.parquet'))
select s_acctbal, s_name, n_name, p_partkey, p_mfgr, s_address, s_phone, s_comment
from part, supplier, partsupp, nation, region
where p_partkey = ps_partkey and s_suppkey = ps_suppkey and p_size = 15 and p_type like '%BRASS' and s_nationkey = n_nationkey
    and n_regionkey = r_regionkey and r_name = 'EUROPE'
    and ps_supplycost = (
            select min(ps_supplycost)
            from partsupp, supplier, nation, region
            where p_partkey = ps_partkey and s_suppkey = ps_suppkey and s_nationkey = n_nationkey and n_regionkey = r_regionkey and r_name = 'EUROPE'
        )
order by s_acctbal desc, n_name, s_name, p_partkey
limit 100;
