-- Static group bys are currently not supported
explain (format schema, preaggregation)
select sum(l_quantity) as sum_qty,
    count(*) as count_order
from lineitem;
