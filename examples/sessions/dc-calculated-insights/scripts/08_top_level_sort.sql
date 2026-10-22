-- Top-level ordering clauses are currently not supported
explain (format schema, preaggregation)
select l_returnflag,
    l_linestatus,
    sum(l_quantity) as sum_qty,
    count(*) as count_order
from lineitem
group by l_returnflag, l_linestatus
order by l_returnflag, l_linestatus;
