#include "dashql/script.h"

#include <stdexcept>

#include "dashql/buffers/index_generated.h"
#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "gtest/gtest.h"

using namespace dashql;

namespace {

TEST(ScriptTest, TextVersionChangesOnlyForSuccessfulTextEdits) {
    Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(100, "");
    script.EraseTextRange(0, 100);
    script.ReplaceText("");
    EXPECT_EQ(script.text_version, 0);

    script.InsertTextAt(100, "a\xC3\xA9z");
    EXPECT_EQ(script.text_version, 1);
    script.InsertTextAt(1, "");
    script.EraseTextRange(1, 0);
    script.EraseTextRange(3, 100);
    script.EraseTextRange(100, 100);
    script.ReplaceText("a\xC3\xA9z");
    EXPECT_EQ(script.text_version, 1);
    EXPECT_EQ(script.ToString(), "a\xC3\xA9z");

    EXPECT_THROW(script.InsertTextAt(0, "\xFF"), std::invalid_argument);
    EXPECT_THROW(script.ReplaceText("\xFF"), std::invalid_argument);
    EXPECT_EQ(script.text_version, 1);
    EXPECT_EQ(script.ToString(), "a\xC3\xA9z");

    script.InsertCharAt(100, '!');
    EXPECT_EQ(script.text_version, 2);
    EXPECT_EQ(script.ToString(), "a\xC3\xA9z!");
    script.EraseTextRange(1, 100);
    EXPECT_EQ(script.text_version, 3);
    EXPECT_EQ(script.ToString(), "a");
    script.ReplaceText("select 1");
    EXPECT_EQ(script.text_version, 4);
}

TEST(ScriptTest, TextVersionAndAnalysisSnapshotExceed32Bits) {
    Catalog catalog;
    Script script{catalog};
    script.text_version = (uint64_t{1} << 32) - 1;
    script.ReplaceText("select 1");
    script.Analyze();
    EXPECT_EQ(script.text_version, uint64_t{1} << 32);
    EXPECT_EQ(script.GetAnalyzedScript()->parsed_script->scanned_script->text_version, script.text_version);
    auto first = script.GetAnalyzedScript();
    script.InsertTextAt(100, ";");
    script.Analyze();
    EXPECT_EQ(script.text_version, (uint64_t{1} << 32) + 1);
    EXPECT_NE(script.GetAnalyzedScript(), first);
    EXPECT_EQ(script.GetAnalyzedScript()->parsed_script->scanned_script->text_version, script.text_version);
}

TEST(ScriptTest, ParseAutoScans) {
    Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, "select 1");
    ASSERT_NO_THROW(script.Parse());
}

TEST(ScriptTest, AnalyzeSpecialFunctionArguments) {
    constexpr std::string_view scripts[] = {
        "select coalesce(a, b)",
        "select nullif(a, b)",
        "select current_time(2)",
        "select substring(a, 1, 2)",
    };

    Catalog catalog;
    for (auto input : scripts) {
        Script script{catalog};
        script.InsertTextAt(0, input);
        ASSERT_NO_THROW(script.Analyze()) << input;
    }
}

TEST(ScriptTest, AnalyzeMalformedQueryWithFunctionArguments) {
    constexpr std::string_view input = R"SQL(
with events as (
    select *,
      ,
), aggregates_other as (
    select ts_hour, count(*) as metric, 'other' as target
    from events
    where not marker
    group by ts_hour, marker
), aggregates_filtered as (
    select ts_hour, count(*) as metric, 'filtered' as target
    from events
    where marker
    group by ts_hour
)
select * from aggregates_other
union all select * from aggregates_filtered
visualize using vegalite (
    mark => line,
    encoding => (
        x => (field => ts_hour, type => temporal),
        y => (field => metric, type => quantitative, aggregate => 'sum'),
        color => (field => target)
    )
);
)SQL";

    Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, input);

    ASSERT_NO_THROW(script.Analyze());
    ASSERT_NE(script.GetParsedScript(), nullptr);
    EXPECT_FALSE(script.GetParsedScript()->errors.empty());
}

TEST(ScriptTest, AnalyzingBeforeParsing) {
    Catalog catalog;
    Script script{catalog};
    ASSERT_THROW(
        {
            try {
                script.Analyze(false);
            } catch (const Exception& e) {
                EXPECT_EQ(e.GetCode(), buffers::status::StatusCode::SCRIPT_NOT_PARSED);
                throw;
            }
        },
        Exception);
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

    Catalog catalog;
    Script external_script{catalog};
    external_script.InsertTextAt(0, external_script_text);
    ASSERT_NO_THROW({
        external_script.Scan();
        external_script.Parse();
        external_script.Analyze();
    });

    Script main_script{catalog};
    main_script.InsertTextAt(0, main_script_text);
    ASSERT_NO_THROW({
        main_script.Scan();
        main_script.Parse();
    });

    ASSERT_NO_THROW(catalog.LoadScript(external_script, 0));
    ASSERT_NO_THROW(main_script.Analyze());
}

TEST(ScriptTest, ReplaceText) {
    Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, "foo");
    ASSERT_EQ(script.ToString(), "foo");
    script.ReplaceText("bar");
    ASSERT_EQ(script.ToString(), "bar");
}

TEST(ScriptTest, ConvertsTextSpanToString) {
    Catalog catalog;
    Script script{catalog};

    script.ReplaceText("select 'Grüße'");
    EXPECT_EQ(script.ToString(TextSpan(7, 9)), "'Grüße'");
    EXPECT_EQ(script.ToString(TextSpan(100, 1)), "");
}

}  // namespace
