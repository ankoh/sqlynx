-- These aggregates can be rolled up today
explain (format schema, preaggregation)
select l_returnflag,
    l_linestatus,
    count(*) as countstar_qty,
    count(l_quantity) as count_qty,
    any_value(l_quantity) as any_qty,
    sum(l_quantity) as sum_qty,
    min(l_quantity) as min_qty,
    max(l_quantity) as max_qty,
    avg(l_quantity) as avg_qty,
    bool_and(l_quantity > 42) as bool_and_qty,
    bool_or(l_quantity > 42) as bool_or_qty
from lineitem
group by l_returnflag, l_linestatus;
