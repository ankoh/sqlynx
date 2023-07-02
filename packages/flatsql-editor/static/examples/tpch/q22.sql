select   country,
         count(*) as numcust,
         sum(balance) as totacctbal
from
         (select substr(c_state,1,1) as country,
                 c_balance as balance
          from   customer
          where  substr(c_phone,1,1) in ('1','2','3','4','5','6','7')
          and    c_balance > (select avg(c_balance)
                              from   customer
                              where  c_balance > 0.00
                                     and substr(c_phone,1,1) in ('1','2','3','4','5','6','7'))
          and not exists (select *
                          from   "order"
                          where  o_c_id = c_id
                                 and o_w_id = c_w_id
                                 and o_d_id = c_d_id)) as country_balance
group by country
order by country
