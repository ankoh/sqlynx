-- @dashql:description
-- Computes shipping revenue between France and Germany in both directions for 1995 and 1996, based
-- on TPC-H data. Revenue is the sum of line item extended price net of discount, grouped by
-- supplier nation, customer nation and ship year.
--
-- Example questions:
-- - What was the revenue of shipments between France and Germany in 1995 and 1996?
-- - How much trade volume flowed from French suppliers to German customers versus the reverse, by
--   year?
-- - Show bilateral supplier-to-customer nation revenue for France and Germany per ship year
-- - Total discounted line item revenue by supplier nation, customer nation and year for two nations
-- - TPC-H volume shipping query for FRANCE and GERMANY
-- @dashql:end

with
    supplier as (select * from external('https://data.dashql.app/tpch-0.001/v1/supplier.parquet')),
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet')),
    lineitem as (select * from external('https://data.dashql.app/tpch-0.001/v1/lineitem.parquet')),
    nation as (select * from external('https://data.dashql.app/tpch-0.001/v1/nation.parquet'))
select supp_nation, cust_nation, l_year, sum(volume) as revenue
from (
    select n1.n_name as supp_nation, n2.n_name as cust_nation, extract(year from l_shipdate) as l_year, l_extendedprice * (1 - l_discount) as volume
    from supplier, lineitem, orders, customer, nation n1, nation n2
    where s_suppkey = l_suppkey and o_orderkey = l_orderkey and c_custkey = o_custkey and s_nationkey = n1.n_nationkey and c_nationkey = n2.n_nationkey and (
            n1.n_name = 'FRANCE' and n2.n_name = 'GERMANY' or n1.n_name = 'GERMANY' and n2.n_name = 'FRANCE'
        ) and l_shipdate between date '1995-01-01' and date '1996-12-31'
) shipping
group by supp_nation, cust_nation, l_year
order by supp_nation, cust_nation, l_year;
