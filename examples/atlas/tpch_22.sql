-- @dashql:description
-- For customers in a fixed set of country codes (the first two digits of the phone number: 13, 31,
-- 23, 29, 30, 18, 17), finds those who have never placed an order and whose account balance is
-- above the average positive balance of customers in those same country codes. Results show the
-- number of such customers and their total account balance per country code (TPC-H global sales
-- opportunity style query).
--
-- Example questions:
-- - How many customers with no orders and above-average balance are there per country code?
-- - Which well-funded customers have never ordered, grouped by phone country prefix?
-- - Total account balance of inactive customers in country codes 13, 31, 23, 29, 30, 18, 17
-- - Show the TPC-H global sales opportunity query by country code
-- - Find customers without orders whose balance exceeds the average positive balance for selected
--   countries
-- @dashql:end

with
    customer as (select * from external('https://data.dashql.app/tpch-0.001/v1/customer.parquet')),
    orders as (select * from external('https://data.dashql.app/tpch-0.001/v1/orders.parquet'))
select cntrycode, count(*) as numcust, sum(c_acctbal) as totacctbal
from (
    select substring(c_phone from 1 for 2) as cntrycode, c_acctbal
    from customer
    where substring(c_phone from 1 for 2) in ('13', '31', '23', '29', '30', '18', '17')
        and c_acctbal > (
                select avg(c_acctbal)
                from customer
                where c_acctbal > 0.00 and substring(c_phone from 1 for 2) in ('13', '31', '23', '29', '30', '18', '17')
            ) and not exists (select * from orders where o_custkey = c_custkey)
) custsale
group by cntrycode
order by cntrycode;
