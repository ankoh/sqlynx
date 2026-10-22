-- A shared Entity label lets one pattern range over every TPC-H vertex table. The relationship solver keeps only source-edge-destination combinations
-- declared below.
with tpch as property graph (
    vertex tables (
        region key (r_regionkey) label Entity properties (r_regionkey as entity_key, r_name as entity_name),
        nation key (n_nationkey) label Entity properties (n_nationkey as entity_key, n_name as entity_name),
        customers key (c_custkey) label Entity properties (c_custkey as entity_key, c_name as entity_name),
        orders key (o_orderkey) label Entity properties (o_orderkey as entity_key, 'Order ' || o_orderkey::text as entity_name),
        lineitem key (l_orderkey, l_linenumber)
            label Entity properties (
                l_orderkey * 10 + l_linenumber as entity_key, 'Line ' || l_orderkey::text || '/' || l_linenumber::text as entity_name
            ), supplier key (s_suppkey) label Entity properties (s_suppkey as entity_key, s_name as entity_name),
        part key (p_partkey) label Entity properties (p_partkey as entity_key, p_name as entity_name),
        partsupp key (ps_partkey, ps_suppkey)
            label Entity properties (
                ps_partkey * 10000 + ps_suppkey as entity_key, 'Part supply ' || ps_partkey::text || '/' || ps_suppkey::text as entity_name
            )
    )
    edge tables (
        nation as in_region key (n_nationkey) source key (n_nationkey) references nation destination key (n_regionkey) references region
            label CommerceRelationship properties ('IN_REGION' as relationship_type),
        customers as customer_in_nation key (c_custkey) source key (c_custkey) references customers destination key (c_nationkey) references nation
            label CommerceRelationship properties ('IN_NATION' as relationship_type),
        supplier as supplier_in_nation key (s_suppkey) source key (s_suppkey) references supplier destination key (s_nationkey) references nation
            label CommerceRelationship properties ('IN_NATION' as relationship_type),
        orders as placed_order key (o_orderkey) source key (o_custkey) references customers destination key (o_orderkey) references orders
            label CommerceRelationship properties ('PLACED_ORDER' as relationship_type),
        lineitem as contains_line key (l_orderkey, l_linenumber) source key (l_orderkey) references orders
            destination key (l_orderkey, l_linenumber) references lineitem label CommerceRelationship properties ('CONTAINS_LINE' as relationship_type),
        lineitem as line_for_part key (l_orderkey, l_linenumber) source key (l_orderkey, l_linenumber) references lineitem
            destination key (l_partkey) references part label CommerceRelationship properties ('FOR_PART' as relationship_type),
        lineitem as line_from_supplier key (l_orderkey, l_linenumber) source key (l_orderkey, l_linenumber) references lineitem
            destination key (l_suppkey) references supplier label CommerceRelationship properties ('FROM_SUPPLIER' as relationship_type),
        partsupp as part_has_supply key (ps_partkey, ps_suppkey) source key (ps_partkey) references part
            destination key (ps_partkey, ps_suppkey) references partsupp label CommerceRelationship properties ('HAS_SUPPLY' as relationship_type),
        partsupp as supply_from_supplier key (ps_partkey, ps_suppkey) source key (ps_partkey, ps_suppkey) references partsupp
            destination key (ps_suppkey) references supplier label CommerceRelationship properties ('FROM_SUPPLIER' as relationship_type)
    )
)
select source_name, relationship_type, destination_name
from graph_table(
    tpch match (source :Entity)-[relationship :CommerceRelationship]->(destination :Entity)
        columns (source.entity_name as source_name, relationship.relationship_type as relationship_type, destination.entity_name as destination_name)
) matches
order by source_name, relationship_type, destination_name
limit 100;