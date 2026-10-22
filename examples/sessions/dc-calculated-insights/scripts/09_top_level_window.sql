-- Top-level windows are currently not supported
explain (format schema, preaggregation)
select l_returnflag,
    l_linestatus,
    count(*) as count_order,
    rank() over (order by count(*)) as rnk
from lineitem
group by l_returnflag, l_linestatus;
