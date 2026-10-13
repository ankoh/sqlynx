-- Explain formatting supports obfuscation through the keyword `with_obfuscated`
explain (format sql, sql_dialect internal_spark_2025_12, with_obfuscated)
select * from nation where regexp_like(n_name, '.*UNITED [KS].*');
