-- @dashql:description
-- Computes total profit per supplier nation and order year for parts whose name contains "green"
-- (TPC-H product type profit measure). Profit is line item revenue after discount minus supply cost
-- times quantity, summed by nation and year, and sorted by nation with the most recent year first.
--
-- Example questions:
-- - What is the total profit by nation and year for green parts?
-- - How much profit did each supplier nation make on parts with 'green' in the name?
-- - Show yearly profit per nation for a given part color, sorted by newest year first
-- - Run the TPC-H product type profit measure query
-- - How do I compute line item profit as discounted price minus supply cost times quantity?
-- @dashql:end

with
    part as (select * from external('https://data.dashql.app/tpch-0.001/v1/part.parquet')),
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    partsupp as (select * from external('https://data.dashql.app/tpch-0.001/v1/partsupp.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet'))
select nation, o_year, sum(amount) as sum_profit
from (
    select n_name as nation, extract(year from o_orderdate) as o_year, l_extendedprice * (1 - l_discount) - ps_supplycost * l_quantity as amount
    from part, supplier, lineitem, partsupp, orders, nation
    where s_suppkey = l_suppkey and ps_suppkey = l_suppkey and ps_partkey = l_partkey and p_partkey = l_partkey and o_orderkey = l_orderkey
        and s_nationkey = n_nationkey and p_name like '%green%'
) profit
group by nation, o_year
order by nation, o_year desc;
