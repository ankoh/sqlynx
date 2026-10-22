-- Treat orders as directed edges from customers to the orders they placed.
with tpch as property graph (
  vertex tables (
    customers key (c_custkey)
      label Customer properties (
        c_custkey as customer_key, c_name as customer_name, c_mktsegment as market_segment,
        c_acctbal as account_balance
      ),
    orders key (o_orderkey)
      label PurchaseOrder properties (
        o_orderkey as order_key, o_orderdate as order_date, o_orderstatus as order_status,
        o_totalprice as total_price
      )
  )
  edge tables (
    orders as placed_order key (o_orderkey) source key (o_custkey) references customers
      destination key (o_orderkey) references orders
      label PlacedOrder properties (o_orderdate as order_date, o_totalprice as total_price)
  )
)
select customer_name, market_segment, order_key, order_date, total_price
from graph_table(
  tpch match (customer :Customer)-[:PlacedOrder]->(customer_order :PurchaseOrder)
    columns (
      customer.customer_name as customer_name, customer.market_segment as market_segment,
      customer_order.order_key as order_key, customer_order.order_date as order_date,
      customer_order.total_price as total_price
    )
) matches
order by total_price desc
limit 20;
