-- @dashql:description
-- Computes Brazil's yearly market share for 1995 and 1996 in the TPC-H Q8 benchmark query. For
-- orders from customers in the AMERICA region and parts of type 'ECONOMY ANODIZED STEEL', it
-- divides revenue (extended price net of discount) from Brazilian suppliers by total revenue from
-- all suppliers, grouped by order year.
--
-- Example questions:
-- - What was Brazil's market share by year for economy anodized steel in America?
-- - How did Brazilian suppliers' share of revenue change between 1995 and 1996?
-- - Show the TPC-H Q8 national market share query
-- - What fraction of ECONOMY ANODIZED STEEL sales to American customers came from Brazil each year?
-- - Compute a supplier nation's share of regional part revenue per order year
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet')),
    region as (select * from external('https://data.dashql.app/tpch-0.001/v1/region.parquet'))
select o_year, sum(case when nation = 'BRAZIL' then volume else 0 end) / sum(volume) as mkt_share
from (
    select extract(year from o_orderdate) as o_year, l_extendedprice * (1 - l_discount) as volume, n2.n_name as nation
    from part, supplier, lineitem, orders, customer, nation n1, nation n2, region
    where p_partkey = l_partkey and s_suppkey = l_suppkey and l_orderkey = o_orderkey and o_custkey = c_custkey and c_nationkey = n1.n_nationkey
        and n1.n_regionkey = r_regionkey and r_name = 'AMERICA' and s_nationkey = n2.n_nationkey
        and o_orderdate between date '1995-01-01' and date '1996-12-31' and p_type = 'ECONOMY ANODIZED STEEL'
) all_nations
group by o_year
order by o_year;
