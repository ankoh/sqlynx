-- With lenient dialect check, formatting succeeds since the call is constant-folded
explain (format sql, sql_dialect internal_spark, with_dialect_check lenient)
select tableau.left('❤', 1);
