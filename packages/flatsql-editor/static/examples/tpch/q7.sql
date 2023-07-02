select
         supp_nation,
         cust_nation,
         l_year,
         sum(amount) as revenue
from
         (select   su_nationkey as supp_nation,
                   substr(c_state,1,1) as cust_nation,
                   extract(year from o_entry_d) as l_year,
                   ol_amount as amount
          from     supplier, stock, orderline, "order", customer, nation n1, nation n2
          where    ol_supply_w_id = s_w_id
                   and ol_i_id = s_i_id
                   and mod((s_w_id * s_i_id), 10000) = su_suppkey
                   and ol_w_id = o_w_id
                   and ol_d_id = o_d_id
                   and ol_o_id = o_id
                   and c_id = o_c_id
                   and c_w_id = o_w_id
                   and c_d_id = o_d_id
                   and su_nationkey = n1.n_nationkey
                   and ascii(substr(c_state,1,1)) = n2.n_nationkey
                   and (
                           (n1.n_name = 'Germany' and n2.n_name = 'Cambodia')
                        or
                           (n1.n_name = 'Cambodia' and n2.n_name = 'Germany')
                       )
                   and ol_delivery_d between timestamp '2007-01-02 00:00:00.000000' and timestamp '2030-01-02 00:00:00.000000'
         ) revenue
group by supp_nation, cust_nation, l_year
order by supp_nation, cust_nation, l_year
