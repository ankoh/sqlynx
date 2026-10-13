-- internal_spark_2025_12 now supports regular expressions
explain (format sql, sql_dialect internal_spark_2025_12)
select * from nation where regexp_like(n_name, '.*UNITED [KS].*');
