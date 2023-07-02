select   n_name,
         l_year,
         sum(amount) as sum_profit
from
         (select n_name,
                 extract(year from o_entry_d) as l_year,
                 ol_amount as amount
          from   item, stock, supplier, orderline, "order", nation
          where  ol_i_id = s_i_id
                 and ol_supply_w_id = s_w_id
                 and mod((s_w_id * s_i_id), 10000) = su_suppkey
                 and ol_w_id = o_w_id
                 and ol_d_id = o_d_id
                 and ol_o_id = o_id
                 and ol_i_id = i_id
                 and su_nationkey = n_nationkey
                 and i_data like '%BB') as nation_year_amount
group by n_name, l_year
order by n_name, l_year desc
