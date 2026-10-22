-- ONE ROW PER STEP turns every matched multi-hop path into one row per edge traversal.
with tpch as property graph (
  vertex tables (
    customers key (c_custkey) label Customer properties (c_name as display_name),
    orders key (o_orderkey) label PurchaseOrder properties ('Order ' || o_orderkey::text as display_name),
    lineitem key (l_orderkey, l_linenumber)
      label LineItem properties ('Line ' || l_orderkey::text || '/' || l_linenumber::text as display_name)
  )
  edge tables (
    orders as placed_order key (o_orderkey) source key (o_custkey) references customers
      destination key (o_orderkey) references orders
      label CommerceStep properties ('PLACED_ORDER' as step_type),
    lineitem as contains_line key (l_orderkey, l_linenumber) source key (l_orderkey) references orders
      destination key (l_orderkey, l_linenumber) references lineitem
      label CommerceStep properties ('CONTAINS_LINE' as step_type)
  )
)
select path_customer, path_order, source_name, step_type, destination_name
from graph_table(
  tpch
    match (customer :Customer where customer.display_name = 'Customer#000000001')-[:CommerceStep]->(customer_order
    :PurchaseOrder)-[:CommerceStep]->(:LineItem)
    one row per step(step_source, step_edge, step_destination)
    columns (
      customer.display_name as path_customer, customer_order.display_name as path_order,
      step_source.display_name as source_name, step_edge.step_type as step_type,
      step_destination.display_name as destination_name
    )
) steps
order by path_order, source_name, destination_name
limit 100;
