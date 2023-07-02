with     revenue (supplier_no, total_revenue) as (
         select supplier_no,
                sum(amount) as total_revenue
         from
               (select mod((s_w_id * s_i_id),10000) as supplier_no,
                       ol_amount as amount
                from orderline, stock
                where ol_i_id = s_i_id and ol_supply_w_id = s_w_id
                      and ol_delivery_d >= timestamp '2007-01-02 00:00:00.000000') as revenue
         group by supplier_no)
select   su_suppkey, su_name, su_address, su_phone, total_revenue
from     supplier, revenue
where    su_suppkey = supplier_no
         and total_revenue = (select max(total_revenue) from revenue)
order by su_suppkey
