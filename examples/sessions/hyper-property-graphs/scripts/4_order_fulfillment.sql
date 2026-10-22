-- Walk customer -> order -> line item -> supplier and filter on graph properties.
with tpch as property graph (
  vertex tables (
    customers key (c_custkey)
      label Customer properties (c_name as customer_name, c_mktsegment as market_segment),
    orders key (o_orderkey)
      label PurchaseOrder properties (
        o_orderkey as order_key, o_orderdate as order_date, o_totalprice as total_price
      ),
    lineitem key (l_orderkey, l_linenumber)
      label LineItem properties (
        l_linenumber as line_number, l_quantity as quantity, l_extendedprice as extended_price,
        l_discount as discount, l_shipdate as ship_date
      ),
    supplier key (s_suppkey)
      label Supplier properties (s_name as supplier_name, s_acctbal as account_balance)
  )
  edge tables (
    orders as placed_order key (o_orderkey) source key (o_custkey) references customers
      destination key (o_orderkey) references orders label PlacedOrder no properties,
    lineitem as contains_line key (l_orderkey, l_linenumber) source key (l_orderkey) references orders
      destination key (l_orderkey, l_linenumber) references lineitem label ContainsLine no properties,
    lineitem as supplied_by key (l_orderkey, l_linenumber)
      source key (l_orderkey, l_linenumber) references lineitem
      destination key (l_suppkey) references supplier label SuppliedBy no properties
  )
)
select customer_name, order_key, line_number, supplier_name, net_price
from graph_table(
  tpch
    match (customer :Customer where customer.market_segment = 'BUILDING')-[:PlacedOrder]->(customer_order
    :PurchaseOrder where customer_order.order_date < date '1995-03-15')-[:ContainsLine]->(item :LineItem
    where item.ship_date > date '1995-03-15')-[:SuppliedBy]->(vendor :Supplier)
    columns (
      customer.customer_name as customer_name, customer_order.order_key as order_key,
      item.line_number as line_number, vendor.supplier_name as supplier_name,
      item.extended_price * (1 - item.discount) as net_price
    )
) matches
order by net_price desc
limit 20;
