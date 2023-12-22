#include "sqlynx/script.h"

#include "gtest/gtest.h"
#include "sqlynx/analyzer/completion.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/schema.h"

using namespace sqlynx;

namespace {

TEST(ScriptTest, ParsingBeforeScanning) {
    Script script{1};
    auto [scanned, status] = script.Parse();
    ASSERT_EQ(scanned, nullptr);
    ASSERT_EQ(status, proto::StatusCode::PARSER_INPUT_NOT_SCANNED);
}

TEST(ScriptTest, ExternalContextCollision) {
    Script schema_script{1};
    schema_script.Scan();
    schema_script.Parse();
    schema_script.Analyze();
    Script main_script{1};
    main_script.Scan();
    main_script.Parse();

    SchemaRegistry registry;
    registry.InsertScript(0, schema_script);
    auto [result, status] = main_script.Analyze(&registry);
    ASSERT_EQ(status, proto::StatusCode::EXTERNAL_CONTEXT_COLLISION);
}

TEST(ScriptTest, AnalyzingBeforeParsing) {
    Script script{1};
    auto [analyzed, status] = script.Analyze();
    ASSERT_EQ(analyzed, nullptr);
    ASSERT_EQ(status, proto::StatusCode::ANALYZER_INPUT_NOT_PARSED);
}

TEST(ScriptTest, TPCH_Q2) {
    const std::string_view external_script_text = R"SQL(
create table part (p_partkey integer not null, p_name varchar(55) not null, p_mfgr char(25) not null, p_brand char(10) not null, p_type varchar(25) not null, p_size integer not null, p_container char(10) not null, p_retailprice decimal(12,2) not null, p_comment varchar(23) not null, primary key (p_partkey));
create table supplier (s_suppkey integer not null, s_name char(25) not null, s_address varchar(40) not null, s_nationkey integer not null, s_phone char(15) not null, s_acctbal decimal(12,2) not null, s_comment varchar(101) not null, primary key (s_suppkey));
create table partsupp (ps_partkey integer not null, ps_suppkey integer not null, ps_availqty integer not null, ps_supplycost decimal(12,2) not null, ps_comment varchar(199) not null, primary key (ps_partkey,ps_suppkey));
create table customer (c_custkey integer not null, c_name varchar(25) not null, c_address varchar(40) not null, c_nationkey integer not null, c_phone char(15) not null, c_acctbal decimal(12,2) not null, c_mktsegment char(10) not null, c_comment varchar(117) not null, primary key (c_custkey));
create table orders (o_orderkey integer not null, o_custkey integer not null, o_orderstatus char(1) not null, o_totalprice decimal(12,2) not null, o_orderdate date not null, o_orderpriority char(15) not null, o_clerk char(15) not null, o_shippriority integer not null, o_comment varchar(79) not null, primary key (o_orderkey));
create table lineitem (l_orderkey integer not null, l_partkey integer not null, l_suppkey integer not null, l_linenumber integer not null, l_quantity decimal(12,2) not null, l_extendedprice decimal(12,2) not null, l_discount decimal(12,2) not null, l_tax decimal(12,2) not null, l_returnflag char(1) not null, l_linestatus char(1) not null, l_shipdate date not null, l_commitdate date not null, l_receiptdate date not null, l_shipinstruct char(25) not null, l_shipmode char(10) not null, l_comment varchar(44) not null, primary key (l_orderkey,l_linenumber));
create table nation (n_nationkey integer not null, n_name char(25) not null, n_regionkey integer not null, n_comment varchar(152) not null, primary key (n_nationkey));
create table region (r_regionkey integer not null, r_name char(25) not null, r_comment varchar(152) not null, primary key (r_regionkey));
    )SQL";

    const std::string_view main_script_text = R"SQL(
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
limit 100
    )SQL";

    Script external_script{1};
    external_script.InsertTextAt(0, external_script_text);
    ASSERT_EQ(external_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(external_script.Parse().second, proto::StatusCode::OK);
    ASSERT_EQ(external_script.Analyze().second, proto::StatusCode::OK);

    Script main_script{2};
    main_script.InsertTextAt(0, main_script_text);
    ASSERT_EQ(main_script.Scan().second, proto::StatusCode::OK);
    ASSERT_EQ(main_script.Parse().second, proto::StatusCode::OK);
    SchemaRegistry search_path;
    search_path.InsertScript(0, external_script);
    ASSERT_EQ(main_script.Analyze(&search_path).second, proto::StatusCode::OK);
}

}  // namespace
