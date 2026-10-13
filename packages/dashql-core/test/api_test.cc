#include "dashql/api.h"

#include "dashql/catalog.h"
#include "dashql/exception.h"
#include "dashql/script_session.h"
#include "gtest/gtest.h"

using namespace dashql;

namespace {

std::pair<std::string_view, std::unique_ptr<char[]>> copyText(std::string_view text) {
    auto buffer = std::unique_ptr<char[]>(new char[text.size()]);
    memcpy(buffer.get(), text.data(), text.size());
    std::string_view buffer_text{buffer.get(), text.size()};
    return {buffer_text, std::move(buffer)};
}

TEST(ApiTest, TPCH_Q2) {
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

    [[maybe_unused]] const std::string_view main_script_text = R"SQL(
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

    // Create a new catalog
    FFIResult catalog_result;
    dashql_catalog_new(&catalog_result);
    auto catalog = reinterpret_cast<Catalog*>(catalog_result.owner_ptr);

    FFIResult external_script_result;
    dashql_script_new(&external_script_result, catalog);
    auto external_script = reinterpret_cast<Script*>(external_script_result.owner_ptr);
    auto [external_text, external_text_buffer] = copyText(external_script_text);
    dashql_script_insert_text_at(external_script, 0, external_text_buffer.release(), external_text.size());

    ASSERT_NO_THROW(dashql_script_scan(external_script));
    ASSERT_NO_THROW(dashql_script_parse(external_script));
    ASSERT_NO_THROW(dashql_script_analyze(external_script, false));

    ASSERT_NO_THROW(dashql_catalog_load_script(catalog, external_script, 0));

    FFIResult main_script_result;
    dashql_script_new(&main_script_result, catalog);
    auto main_script = reinterpret_cast<Script*>(main_script_result.owner_ptr);
    auto [main_text, main_text_buffer] = copyText(external_script_text);
    dashql_script_insert_text_at(main_script, 0, main_text_buffer.release(), main_text.size());

    ASSERT_NO_THROW(dashql_script_scan(main_script));
    ASSERT_NO_THROW(dashql_script_parse(main_script));
    ASSERT_NO_THROW(dashql_script_analyze(main_script, false));

    dashql_delete_owner(main_script_result.owner_ptr, main_script_result.owner_deleter);
    dashql_delete_owner(external_script_result.owner_ptr, external_script_result.owner_deleter);
    dashql_delete_owner(catalog_result.owner_ptr, catalog_result.owner_deleter);
}

TEST(ApiTest, GetStatementTextExcludesSeparatorAndTrivia) {
    Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, "  SELECT ';' AS value ; -- trailing comment\n");

    EXPECT_EQ(script.GetStatementText(), "SELECT ';' AS value");
}

TEST(ApiTest, LoadScriptsUsesCompactPointerAndRankArrays) {
    Catalog catalog;
    Script relations{catalog};
    Script functions{catalog};
    relations.InsertTextAt(0, "create table db.schema.items(id int);");
    functions.InsertTextAt(0, "create function db.schema.item_count() returns int;");
    relations.Analyze();
    functions.Analyze();
    Script* scripts[] = {&relations, &functions};
    const uint32_t ranks[] = {7, 3};
    auto previous_version = catalog.GetVersion();

    ASSERT_NO_THROW(dashql_catalog_load_scripts(&catalog, scripts, ranks, 2));
    EXPECT_EQ(catalog.GetVersion(), previous_version + 1);
    EXPECT_TRUE(catalog.Contains(relations.GetCatalogEntryId()));
    EXPECT_TRUE(catalog.Contains(functions.GetCatalogEntryId()));
}

TEST(ApiTest, AnalysisPublishesResultsBeforeReturning) {
    Catalog catalog;
    Script first{catalog};
    Script second{catalog};
    first.InsertTextAt(0, "select 1");
    second.InsertTextAt(0, "select 2");

    ASSERT_NO_THROW(dashql_script_analyze(&first, true));
    EXPECT_NE(first.GetAnalyzedScript(), nullptr);
    EXPECT_EQ(second.GetAnalyzedScript(), nullptr);
    ASSERT_NO_THROW(dashql_script_analyze(&second, true));
    EXPECT_NE(second.GetAnalyzedScript(), nullptr);
}

TEST(ApiTest, AnalysisAllowsImmediateReadAndReanalysisAfterEdit) {
    Catalog catalog;
    Script script{catalog};
    script.InsertTextAt(0, "select 1");
    ASSERT_NO_THROW(dashql_script_analyze(&script, true));
    auto first_analysis = script.GetAnalyzedScript();
    EXPECT_EQ(script.ToString(), "select 1");
    script.ReplaceText("select 2");
    ASSERT_NO_THROW(dashql_script_analyze(&script, true));
    ASSERT_NE(script.GetAnalyzedScript(), nullptr);
    EXPECT_NE(script.GetAnalyzedScript(), first_analysis);
    EXPECT_EQ(script.GetAnalyzedScript()->parsed_script->scanned_script->text_version, script.text_version);
    EXPECT_EQ(script.ToString(), "select 2");
}

TEST(ApiTest, AnalysisThrowsErrorsDirectlyAndAllowsRecovery) {
    Catalog catalog;
    Script invalid{catalog};
    try {
        dashql_script_analyze(&invalid, false);
        FAIL() << "Expected analysis without parsing to throw";
    } catch (const Exception& error) {
        EXPECT_EQ(error.GetCode(), buffers::status::StatusCode::SCRIPT_NOT_PARSED);
        EXPECT_STREQ(error.what(), "Script is not parsed");
    }
    EXPECT_EQ(invalid.ToString(), "");
    EXPECT_EQ(invalid.GetAnalyzedScript(), nullptr);
    invalid.InsertTextAt(0, "select 1");
    ASSERT_NO_THROW(dashql_script_analyze(&invalid, true));
    EXPECT_NE(invalid.GetAnalyzedScript(), nullptr);
}

TEST(ApiTest, FailedCatalogAnalysisDoesNotBlockScriptSessions) {
    Catalog catalog;
    Script invalid{catalog};
    EXPECT_THROW(dashql_script_analyze(&invalid, false), Exception);

    ScriptSession session{catalog, buffers::editor::EditorOffsetUnit::UTF16_CODE_UNITS};
    auto replaced = session.ReplaceText(0, "select 1");
    EXPECT_EQ(replaced.status, buffers::editor::EditorUpdateStatus::OK);
    auto analyzed = session.Analyze();
    EXPECT_EQ(analyzed.status, buffers::editor::EditorUpdateStatus::OK);
    EXPECT_TRUE(analyzed.analysis_available);
}

TEST(ApiTest, SessionAndExecutionExpose64BitTextVersions) {
    Catalog catalog;
    ScriptSession session{catalog};
    const auto version = (uint64_t{1} << 32) + 42;
    session.GetScript().text_version = version - 1;
    auto* text = reinterpret_cast<char*>(dashql_malloc(8));
    memcpy(text, "select 1", 8);
    FFIResult result{};
    dashql_script_session_replace_text(&result, &session, version - 1, text, 8);
    auto* update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(result.data_ptr);
    EXPECT_EQ(update->status(), buffers::editor::EditorUpdateStatus::OK);
    EXPECT_EQ(update->text_version(), version);
    EXPECT_EQ(dashql_script_session_get_text_version(&session), version);
    dashql_delete_owner(result.owner_ptr, result.owner_deleter);

    dashql_script_session_set_primary_cursor(&result, &session, version - 1, 0);
    update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(result.data_ptr);
    EXPECT_EQ(update->status(), buffers::editor::EditorUpdateStatus::STALE_TEXT_VERSION);
    EXPECT_EQ(update->text_version(), version);
    dashql_delete_owner(result.owner_ptr, result.owner_deleter);

    dashql_script_session_apply(&result, &session, nullptr, 0);
    update = flatbuffers::GetRoot<buffers::editor::EditorUpdate>(result.data_ptr);
    EXPECT_EQ(update->status(), buffers::editor::EditorUpdateStatus::INVALID_EVENT);
    EXPECT_EQ(update->text_version(), version);
    dashql_delete_owner(result.owner_ptr, result.owner_deleter);

    dashql_script_execution_new(&result, &session,
                                static_cast<size_t>(buffers::formatting::FormattingDialect::HYPER),
                                static_cast<size_t>(buffers::formatting::FormattingMode::INLINE), 80, 4, false);
    auto* execution = reinterpret_cast<execution::ScriptExecution*>(result.owner_ptr);
    session.GetScript().ReplaceText("select 2");
    FFIResult started{};
    dashql_script_execution_start(&started, execution);
    auto* execution_update = flatbuffers::GetRoot<buffers::execution::ScriptExecutionUpdate>(started.data_ptr);
    ASSERT_NE(execution_update->snapshot(), nullptr);
    EXPECT_EQ(execution_update->snapshot()->text_version(), version);
    dashql_delete_owner(started.owner_ptr, started.owner_deleter);
    dashql_delete_owner(result.owner_ptr, result.owner_deleter);
}

}  // namespace
