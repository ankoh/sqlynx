-- Create a view over a materialized table
create or replace view view_over_nation as select * from nation;

-- `expand_views true` will format `nation`
explain (format sql, sql_dialect internal_spark_2025_12, expand_views true)
select * from view_over_nation
