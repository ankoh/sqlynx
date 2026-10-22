-- Create a view over a materialized table
create or replace view view_over_nation as select * from nation;

-- `expand_views true` will report `nation_materialized` as referenced table
explain (format referenced_tables, expand_views true)
select * from view_over_nation
