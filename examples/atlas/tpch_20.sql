-- @dashql:description
-- Lists the names and addresses of Canadian suppliers that hold excess stock of parts whose names
-- start with "forest". A supplier qualifies if, for such a part, its available quantity is more
-- than half of the quantity of that part it shipped during 1994. Results are sorted by supplier
-- name (TPC-H potential part promotion query).
--
-- Example questions:
-- - Which Canadian suppliers have more than half of their 1994 shipped quantity in stock for forest
--   parts?
-- - List supplier names and addresses in CANADA with excess availability of parts named forest%
-- - Which suppliers are candidates for a forest part promotion?
-- - Find suppliers whose available quantity exceeds 50% of 1994 line item shipments for a part
-- - TPC-H potential part promotion query for Canada
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    partsupp as (select * from external('https://data.dashql.app/tpch-0.001/v1/partsupp.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet'))
select s_name, s_address
from supplier, nation
where s_suppkey in (
        select ps_suppkey
        from partsupp
        where ps_partkey in (select p_partkey from part where p_name like 'forest%')
            and ps_availqty > (
                    select 0.5 * sum(l_quantity)
                    from lineitem
                    where l_partkey = ps_partkey and l_suppkey = ps_suppkey and l_shipdate >= date '1994-01-01' and l_shipdate < date '1995-01-01'
                )
    ) and s_nationkey = n_nationkey and n_name = 'CANADA'
order by s_name;
