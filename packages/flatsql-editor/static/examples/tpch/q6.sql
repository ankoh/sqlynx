select  sum(ol_amount) as revenue
from    orderline
where   ol_delivery_d >= timestamp '1999-01-01 00:00:00.000000'
        and ol_delivery_d < timestamp '2030-01-01 00:00:00.000000'
        and ol_quantity between 1 and 100000
