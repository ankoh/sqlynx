select   i_name,
         brand,
         i_price,
         count(distinct (mod((s_w_id * s_i_id),10000))) as supplier_cnt
from
        (select i_name,
                substr(i_data, 1, 3) as brand,
                i_price,
                s_w_id,
                s_i_id
         from   stock, item
         where  i_id = s_i_id
                and i_data not like 'zz%'
                and (mod((s_w_id * s_i_id),10000)) not in (select su_suppkey from supplier where su_comment like '%bad%')) as good_items
group by i_name, brand, i_price
order by supplier_cnt desc
limit 100
