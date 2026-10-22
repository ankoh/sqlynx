-- The option WITH_LINEAGE allows you to resolve the origin(s) of a column
explain (format schema, with_lineage)
select * from nation
