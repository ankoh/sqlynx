#include "flatsql/vis/schema_graph.h"

#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;

namespace {

TEST(SchemaGraphTest, TPCHQ2) {
    const std::string_view tpch_schema = R"SQL(
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));
    )SQL";
    const std::string_view tpch_q2 = R"SQL(
select
    s_acctbal,
    s_name,
    n_name,
    p_partkey,
    p_mfgr,
    s_address,
    s_phone,
    s_comment
from
    part,
    supplier,
    partsupp,
    nation,
    region
where
    p_partkey = ps_partkey
    and s_suppkey = ps_suppkey
    and p_size = 15
    and p_type like '%BRASS'
    and s_nationkey = n_nationkey
    and n_regionkey = r_regionkey
    and r_name = 'EUROPE'
    and ps_supplycost = (
        select
            min(ps_supplycost)
        from
            partsupp,
            supplier,
            nation,
            region
        where
            p_partkey = ps_partkey
            and s_suppkey = ps_suppkey
            and s_nationkey = n_nationkey
            and n_regionkey = r_regionkey
            and r_name = 'EUROPE'
    )
order by
    s_acctbal desc,
    n_name,
    s_name,
    p_partkey
limit
	100
    )SQL";

    Script schema_script;
    schema_script.InsertTextAt(0, tpch_schema);
    ASSERT_EQ(schema_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(schema_script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(schema_script.Analyze().second, proto::StatusCode::OK);

    Script query_script;
    query_script.InsertTextAt(0, tpch_q2);
    ASSERT_EQ(query_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(query_script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(query_script.Analyze(&schema_script).second, proto::StatusCode::OK);

    SchemaGraph graph;
    SchemaGraph::Config config;
    config.iteration_count = 10;
    config.force_scaling = 1.0;
    config.initial_radius = 100;
    config.cooldown_factor = 0.85;
    config.repulsion_force = 15.0;
    config.edge_attraction_force = 15.0;
    config.gravity_force = 15.0;
    config.board_width = 1600;
    config.board_height = 800;
    config.table_width = 100;
    config.table_constant_height = 24;
    config.table_column_height = 8;
    config.table_max_height = 96;
    config.table_margin = 20;

    for (size_t i = 0; i < 3; ++i) {
        graph.Configure(config);
        graph.LoadScript(query_script.analyzed_scripts.back());
    }

    auto& tables = graph.GetNodes();
    auto& edges = graph.GetEdges();
    auto& edge_nodes = graph.GetEdgeNodes();
    ASSERT_EQ(tables.size(), 8);
    ASSERT_EQ(edges.size(), 9);
    ASSERT_EQ(edge_nodes.size(), 27);

    std::stringstream ss;
    ss << "[";
    for (size_t i = 0; i < tables.size(); ++i) {
        if (i > 0) {
            ss << ", ";
        }
        ss << "(" << tables[i].position.x << "," << tables[i].position.y << ")";
    }
    ss << "]";
    ss << std::endl;
    std::cout << ss.str() << std::endl;
}

}  // namespace
