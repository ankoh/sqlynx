#include "dashql/parser/parser.h"

#include <algorithm>
#include <optional>

#include "dashql/buffers/index_generated.h"
#include "dashql/formatter/formatter.h"
#include "dashql/parser/parse_context.h"
#include "dashql/parser/scanner.h"
#include "dashql/script.h"
#include "gtest/gtest.h"

using namespace dashql;
using namespace dashql::parser;

using ScannerToken = buffers::parser::ScannerTokenType;
using ParserSymbol = Parser::symbol_kind_type;

namespace {

TEST(ParserTest, FindNodeAtOffset) {
    std::shared_ptr<ParsedScript> script;

    // Helper to parse a script
    auto parse = [&](std::string_view text) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto scanned = Scanner::Scan(buffer, 0, 2);
        auto parsed = Parser::Parse(scanned);
        script = std::move(parsed);
    };
    /// Test if ast node matches
    auto test_node_at_offset = [&](size_t text_offset, size_t expected_statement_id,
                                   buffers::parser::NodeType expect_node_type, sx::parser::SymbolSpan expect_loc) {
        auto result = script->FindNodeAtOffset(text_offset);
        ASSERT_TRUE(result.has_value()) << "offset=" << text_offset;
        auto [statement_id, node_id] = *result;
        ASSERT_EQ(statement_id, expected_statement_id);
        ASSERT_LT(node_id, script->nodes.size());
        auto& node = script->nodes[node_id];
        ASSERT_EQ(node.node_type(), expect_node_type);
        ASSERT_EQ(node.symbol_span().offset(), expect_loc.offset());
        ASSERT_EQ(node.symbol_span().length(), expect_loc.length());
    };

    parse("select 1");
    test_node_at_offset(0, 0, buffers::parser::NodeType::OBJECT_SQL_SELECT, sx::parser::SymbolSpan(0, 2));
    test_node_at_offset(1, 0, buffers::parser::NodeType::OBJECT_SQL_SELECT, sx::parser::SymbolSpan(0, 2));
    test_node_at_offset(2, 0, buffers::parser::NodeType::OBJECT_SQL_SELECT, sx::parser::SymbolSpan(0, 2));
    test_node_at_offset(7, 0, buffers::parser::NodeType::LITERAL_INTEGER, sx::parser::SymbolSpan(1, 1));
}

// Helper: parse a script and return the resulting ParsedScript.
static std::shared_ptr<ParsedScript> ParseString(std::string_view text) {
    rope::Rope buffer{128};
    buffer.Insert(0, text);
    auto scanned = Scanner::Scan(buffer, 0, 2);
    return Parser::Parse(scanned);
}

TEST(ParserTest, ParsesSemiAndAntiJoins) {
    for (auto input : {
             "select * from a anti join b on a.id = b.id",
             "select * from a semi join b on a.id = b.id",
         }) {
        auto script = ParseString(input);
        ASSERT_TRUE(script->errors.empty())
            << input << ": " << (script->errors.empty() ? "" : script->errors.front().message);
    }
}

TEST(ParserTest, ParsesArrayElementTypeInCast) {
    struct TestCase {
        std::string_view input;
        std::string_view trino;
        std::string_view hyper;
    };
    constexpr std::array<TestCase, 4> tests = {{
        {"select cast(json_parse('[1,2]') as array(json))", "select cast(json_parse('[1,2]') as array(json));",
         "select cast(json_parse('[1,2]') as json[]);"},
        {"select cast(payload as array(array(json))) from events",
         "select cast(payload as array(array(json))) from events;",
         "select cast(payload as json[][]) from events;"},
        {"select cast(payload as json[]) from events", "select cast(payload as array(json)) from events;",
         "select cast(payload as json[]) from events;"},
        {"SELECT CAST(payload AS ARRAY(JSON)) FROM events", "select cast(payload as array(JSON)) from events;",
         "select cast(payload as JSON[]) from events;"},
    }};

    buffers::formatting::FormattingConfigT config;
    config.mode = buffers::formatting::FormattingMode::INLINE;
    for (const auto& test : tests) {
        SCOPED_TRACE(test.input);
        auto script = ParseString(test.input);
        ASSERT_TRUE(script->errors.empty())
            << (script->errors.empty() ? "" : script->errors.front().message);
        ASSERT_EQ(script->statements.size(), 1u);
        for (auto [dialect, expected] : {
                 std::pair{buffers::formatting::FormattingDialect::TRINO, test.trino},
                 std::pair{buffers::formatting::FormattingDialect::HYPER, test.hyper},
             }) {
            config.dialect = dialect;
            Formatter formatter{*script};
            EXPECT_EQ(formatter.Format(config), expected);
            EXPECT_TRUE(formatter.IsFullyFormatted());
        }
    }
}

TEST(ParserTest, ParsesSemiAndAntiJoinsInCteUnion) {
    constexpr std::string_view input = R"SQL(WITH `cte_table_6` AS (
  SELECT `o_orderkey`, `_record_type` FROM `orders_cdf`
  WHERE (`_record_type` IN ('DELETE','UPDATE_PREIMAGE'))
),
`cte_table_12` AS (
  SELECT `o_orderkey`, `_record_type` FROM `orders_cdf`
  WHERE (`_record_type` IN ('INSERT','UPDATE_POSTIMAGE'))
)
SELECT * FROM ((
  SELECT * FROM `cte_table_6` AS `before`
  ANTI JOIN `cte_table_12` AS `after`
  ON (`before`.`o_orderkey` = `after`.`o_orderkey`)
) UNION ALL (
  SELECT * FROM `cte_table_12` AS `after`
  SEMI JOIN `cte_table_6` AS `before`
  ON (`after`.`o_orderkey` = `before`.`o_orderkey`)
)) AS `union_2`)SQL";

    auto script = ParseString(input);
    ASSERT_TRUE(script->errors.empty()) << (script->errors.empty() ? "" : script->errors.front().message);
}

TEST(ParserTest, ExposesNormalizedStatementMetadata) {
    struct TestCase {
        std::string_view input;
        buffers::parser::StatementType statement_type;
        buffers::parser::StatementTargetType target_type;
        std::string_view target_database;
        std::string_view target_schema;
        std::string_view target_relation;
        std::string_view attach_path;
        std::string_view attach_alias;
        bool attach_local;
    };
    constexpr std::array<TestCase, 11> tests = {{
        {"create table foo (a integer)", buffers::parser::StatementType::CREATE_TABLE,
         buffers::parser::StatementTargetType::TABLE, {}, {}, "foo", {}, {}, false},
        {"create table target as select 1", buffers::parser::StatementType::CREATE_TABLE_AS,
         buffers::parser::StatementTargetType::TABLE, {}, {}, "target", {}, {}, false},
        {"create view catalog.schema.target as select 1", buffers::parser::StatementType::CREATE_VIEW,
         buffers::parser::StatementTargetType::VIEW, "catalog", "schema", "target", {}, {}, false},
        {"drop table if exists schema.\"Target\"", buffers::parser::StatementType::DROP_TABLE,
         buffers::parser::StatementTargetType::TABLE, {}, "schema", "Target", {}, {}, false},
        {"drop view target", buffers::parser::StatementType::DROP_VIEW,
         buffers::parser::StatementTargetType::VIEW, {}, {}, "target", {}, {}, false},
        {"select 1 into schema.target", buffers::parser::StatementType::SELECT_INTO,
         buffers::parser::StatementTargetType::TABLE, {}, "schema", "target", {}, {}, false},
        {"select 1 into schema.target union all select 2", buffers::parser::StatementType::SELECT_INTO,
         buffers::parser::StatementTargetType::TABLE, {}, "schema", "target", {}, {}, false},
        {"insert into catalog.schema.target values (1)", buffers::parser::StatementType::INSERT,
         buffers::parser::StatementTargetType::TABLE, "catalog", "schema", "target", {}, {}, false},
        {"delete from only catalog.schema.\"Target\" as t returning t.id", buffers::parser::StatementType::DELETE,
         buffers::parser::StatementTargetType::TABLE, "catalog", "schema", "Target", {}, {}, false},
        {"attach database \"path/to/source.hyper\" as source", buffers::parser::StatementType::ATTACH_DATABASE,
         buffers::parser::StatementTargetType::NONE, {}, {}, {}, "path/to/source.hyper", "source", false},
        {"attach local database local_source as attached with (access_mode = 'readonly')",
         buffers::parser::StatementType::ATTACH_DATABASE, buffers::parser::StatementTargetType::NONE, {}, {}, {},
         "local_source", "attached", true},
    }};

    for (size_t test_id = 0; test_id < tests.size(); ++test_id) {
        const auto& test = tests[test_id];
        SCOPED_TRACE(test_id);
        auto script = ParseString(test.input);
        ASSERT_TRUE(script->errors.empty())
            << test.input << ": " << (script->errors.empty() ? "" : script->errors.front().message);
        ASSERT_EQ(script->statements.size(), 1u) << test.input;

        flatbuffers::FlatBufferBuilder builder;
        builder.Finish(script->Pack(builder));
        auto* parsed = flatbuffers::GetRoot<buffers::parser::ParsedScript>(builder.GetBufferPointer());
        auto* statement = parsed->statements()->Get(0);
        EXPECT_EQ(statement->statement_type(), test.statement_type) << test.input;
        EXPECT_EQ(statement->target_type(), test.target_type) << test.input;
        auto* target = statement->target();
        EXPECT_EQ(target && target->database_name() ? target->database_name()->string_view() : std::string_view{},
                  test.target_database) << test.input;
        EXPECT_EQ(target && target->schema_name() ? target->schema_name()->string_view() : std::string_view{},
                  test.target_schema) << test.input;
        EXPECT_EQ(target && target->relation_name() ? target->relation_name()->string_view() : std::string_view{},
                  test.target_relation) << test.input;
        auto* attach = statement->attach_database();
        EXPECT_EQ(attach && attach->path() ? attach->path()->string_view() : std::string_view{}, test.attach_path)
            << test.input;
        EXPECT_EQ(attach && attach->alias() ? attach->alias()->string_view() : std::string_view{}, test.attach_alias)
            << test.input;
        EXPECT_EQ(attach ? attach->local() : false, test.attach_local) << test.input;
    }
}

TEST(ParserTest, ParsesDeleteForms) {
    for (auto input : {
             "delete from target",
             "delete from target where id = 1 returning *",
             "delete from only (schema.target) as t where t.id = 1",
             "delete from schema.target * t using source s, audit a where t.id = s.id returning t.id, a.id as aid",
             "delete from target t using source s join audit a on s.id = a.id where t.id = s.id",
             "delete from target t where exists (select 1 from source s where s.id = t.id)",
             "delete from target returning (select id from source)",
             "with source as (select 1 as id) delete from target using source where target.id = source.id",
             "with recursive source as (select 1 as id) delete from target returning id",
             "explain delete from target where id = 1",
             "explain (analyze false) with source as (select 1) delete from target returning *",
         }) {
        SCOPED_TRACE(input);
        auto script = ParseString(input);
        ASSERT_TRUE(script->errors.empty()) << (script->errors.empty() ? "" : script->errors.front().message);
        ASSERT_EQ(script->statements.size(), 1u);
        EXPECT_EQ(script->statements[0].type, std::string_view{input}.starts_with("explain")
                                                  ? buffers::parser::StatementType::EXPLAIN
                                                  : buffers::parser::StatementType::DELETE);
    }
    for (auto input : {"delete target", "delete from", "delete from target using", "delete from target returning"}) {
        SCOPED_TRACE(input);
        EXPECT_FALSE(ParseString(input)->errors.empty());
    }
}

TEST(ParserTest, FormatsDeleteKeywordCaseWithoutChangingNamesOrLiterals) {
    auto script = ParseString("with ids as (select 1 as id) delete from \"Target\" t using ids "
                              "where t.id = ids.id returning 'KeepCase' as \"Label\"");
    ASSERT_TRUE(script->errors.empty());
    buffers::formatting::FormattingConfigT config;
    config.mode = buffers::formatting::FormattingMode::INLINE;
    config.keyword_case = buffers::formatting::KeywordCase::UPPER;
    Formatter formatter{*script};
    EXPECT_EQ(formatter.Format(config), "WITH ids AS (SELECT 1 AS id) DELETE FROM \"Target\" t USING ids "
                                       "WHERE t.id = ids.id RETURNING 'KeepCase' AS \"Label\";");
    EXPECT_TRUE(formatter.IsFullyFormatted());
}

TEST(ParserTest, ParsesHyperInsertForms) {
    constexpr std::array<std::string_view, 9> tests = {{
        "insert into target values (1), (2)",
        "insert into analytics.target(id, label) values (1, default)",
        "insert into target(id, label) select id, label from source",
        "insert into target table source",
        "insert into target default values",
        "with source as (select 1 as id) insert into target select id from source",
        "with recursive source as (select 1 as id) insert into target select id from source",
        "insert into target(id) values (1) returning id, id + 1 as next_id",
        "explain insert into target values (1)",
    }};

    for (auto input : tests) {
        SCOPED_TRACE(input);
        auto script = ParseString(input);
        ASSERT_TRUE(script->errors.empty())
            << (script->errors.empty() ? "" : script->errors.front().message);
        ASSERT_EQ(script->statements.size(), 1u);
    }
}

TEST(ParserTest, ParsesHyperCreateViewForms) {
    struct TestCase {
        std::string_view input;
        bool or_replace;
        bool temporary;
    };
    constexpr std::array<TestCase, 4> tests = {{
        {"CREATE VIEW result AS SELECT 1", false, false},
        {"CREATE OR REPLACE VIEW result AS SELECT 1", true, false},
        {"CREATE TEMP VIEW result AS SELECT 1", false, true},
        {"CREATE OR REPLACE TEMP VIEW result AS SELECT 1", true, true},
    }};

    for (const auto& test : tests) {
        SCOPED_TRACE(test.input);
        auto script = ParseString(test.input);
        ASSERT_TRUE(script->errors.empty())
            << (script->errors.empty() ? "" : script->errors.front().message);
        ASSERT_EQ(script->statements.size(), 1u);
        EXPECT_EQ(script->statements.front().type, buffers::parser::StatementType::CREATE_VIEW);
        const auto& root = script->nodes[script->statements.front().root];
        auto children = std::span{script->nodes}.subspan(root.children_begin_or_value(), root.children_count());
        auto has_attribute = [&](buffers::parser::AttributeKey key) {
            return std::ranges::any_of(children, [key](const auto& child) { return child.attribute_key() == key; });
        };
        EXPECT_EQ(has_attribute(buffers::parser::AttributeKey::SQL_VIEW_OR_REPLACE), test.or_replace);
        EXPECT_EQ(has_attribute(buffers::parser::AttributeKey::SQL_VIEW_TEMP), test.temporary);
    }
}

TEST(ParserTest, RejectsExcludedInsertForms) {
    for (auto input : {
             std::string_view{"insert bulk into target values (1)"},
             std::string_view{"insert into target overriding system value values (1)"},
             std::string_view{"insert into target values (1) on conflict do nothing"},
         }) {
        SCOPED_TRACE(input);
        auto script = ParseString(input);
        EXPECT_FALSE(script->errors.empty());
    }
}

TEST(ParserTest, DoesNotFullyFormatDefaultOutsideInsertValues) {
    auto script = ParseString("select default");
    ASSERT_TRUE(script->errors.empty());

    buffers::formatting::FormattingConfigT config;
    config.dialect = buffers::formatting::FormattingDialect::HYPER;
    config.mode = buffers::formatting::FormattingMode::INLINE;
    Formatter formatter{*script};
    formatter.Format(config);
    EXPECT_FALSE(formatter.IsFullyFormatted());
}

TEST(ParserTest, FormatsDropAndAttachStatements) {
    struct TestCase {
        std::string_view input;
        std::string_view expected;
    };
    constexpr std::array<TestCase, 4> tests = {{
        {"DROP TABLE IF EXISTS Schema_1.Target", "drop table if exists Schema_1.Target;"},
        {"DROP VIEW Target", "drop view Target;"},
        {"ATTACH DATABASE \"path/to/source.hyper\" AS Source",
         "attach database \"path/to/source.hyper\" as Source;"},
        {"ATTACH LOCAL DATABASE local_source AS Attached WITH (access_mode='readonly', encryption_key=DEFAULT)",
         "attach local database local_source as Attached with (access_mode = 'readonly', encryption_key = DEFAULT);"},
    }};

    buffers::formatting::FormattingConfigT config;
    config.dialect = buffers::formatting::FormattingDialect::HYPER;
    config.mode = buffers::formatting::FormattingMode::COMPACT;
    config.max_width = 120;
    for (const auto& test : tests) {
        auto script = ParseString(test.input);
        ASSERT_TRUE(script->errors.empty())
            << test.input << ": " << (script->errors.empty() ? "" : script->errors.front().message);
        Formatter formatter{*script};
        EXPECT_EQ(formatter.Format(config), test.expected) << test.input;
        EXPECT_TRUE(formatter.IsFullyFormatted()) << test.input;
    }
}

TEST(ParserTest, HintForStringLiteralWhereIdentExpected) {
    // FROM expects an identifier-like name. A bare SCONST should produce a hint to use a
    // double-quoted identifier instead.
    auto script = ParseString("select * from 'foo'");
    ASSERT_FALSE(script->errors.empty());
    EXPECT_NE(script->errors.front().hint.find("double-quoted identifier"), std::string::npos);
}

TEST(ParserTest, NoHintWhenStringLiteralIsValid) {
    // SELECT 1 AS 'one' is accepted by the grammar (sql_col_label_or_string), so no error and no
    // hint should be produced.
    auto script = ParseString("select 1 as 'one'");
    EXPECT_TRUE(script->errors.empty());
}

TEST(ParserTest, ParsesDollarParametersAndArraySlices) {
    constexpr std::array<std::string_view, 5> inputs = {
        "SELECT $name", "SELECT $1", "SELECT values[:2]", "SELECT values[1:]", "SELECT values[:]",
    };

    for (auto input : inputs) {
        auto script = ParseString(input);
        EXPECT_TRUE(script->errors.empty())
            << input << ": " << (script->errors.empty() ? "" : script->errors.front().message);
        EXPECT_EQ(script->statements.size(), 1u) << input;
    }
}

TEST(ParserTest, HintForStringLiteralAsImplicitAlias) {
    // `select 1 'foo'` errors at SCONST because the implicit-alias rule requires IDENT (only
    // explicit AS accepts a string literal). IDENT would have been valid → hint should appear.
    auto script = ParseString("select 1 'foo'");
    ASSERT_FALSE(script->errors.empty());
    EXPECT_NE(script->errors.front().hint.find("double-quoted identifier"), std::string::npos);
}

TEST(ParserTest, NoHintWhenIdentAlsoInvalid) {
    // `select from foo` errors at FROM because no expression precedes it; an IDENT in place of FROM
    // would not parse either, so no hint should be attached.
    auto script = ParseString("select 1 from from");
    ASSERT_FALSE(script->errors.empty());
    EXPECT_TRUE(script->errors.front().hint.empty());
}

TEST(ParserTest, AssociatesLeadingCommentBlocksWithStatements) {
    constexpr std::string_view text =
        "-- first statement\n"
        "-- has two lines\n"
        "select 1;\n"
        "\n"
        "/* second statement */\n"
        "select 2; -- trailing\n"
        "select 3";
    auto script = ParseString(text);

    ASSERT_EQ(script->statements.size(), 3u);
    ASSERT_EQ(script->scanned_script->comments.size(), 4u);
    auto descriptions = script->AssociateDescriptions();
    ASSERT_EQ(descriptions.size(), 3u);

    auto& first = descriptions[0];
    EXPECT_EQ(first.description_begin, 0u);
    EXPECT_EQ(first.description_count, 2u);
    EXPECT_EQ(text.substr(first.statement_span.offset(), first.statement_span.length()), "select 1");
    EXPECT_EQ(text.substr(first.source_span.offset(), first.source_span.length()), "select 1;");

    auto& second = descriptions[1];
    EXPECT_EQ(second.description_begin, 2u);
    EXPECT_EQ(second.description_count, 1u);
    EXPECT_EQ(text.substr(second.statement_span.offset(), second.statement_span.length()), "select 2");
    EXPECT_EQ(text.substr(second.source_span.offset(), second.source_span.length()), "select 2; -- trailing");

    auto& third = descriptions[2];
    EXPECT_EQ(third.description_count, 0u);
    EXPECT_EQ(text.substr(third.statement_span.offset(), third.statement_span.length()), "select 3");
    EXPECT_EQ(text.substr(third.source_span.offset(), third.source_span.length()), "select 3");
}

TEST(ParserTest, StatementSpanExcludesWhitespaceBeforeSeparator) {
    constexpr std::string_view text = "  select 'Grüße;'\n  ; -- trailing";
    auto script = ParseString(text);

    ASSERT_TRUE(script->errors.empty());
    ASSERT_EQ(script->statements.size(), 1u);
    auto description = script->AssociateDescriptions().front();
    EXPECT_EQ(text.substr(description.statement_span.offset(), description.statement_span.length()), "select 'Grüße;'");
    EXPECT_EQ(text.substr(description.source_span.offset(), description.source_span.length()),
              "select 'Grüße;'\n  ; -- trailing");
}

TEST(ParserTest, ParsesHyperQueryWithObfuscatedLiterals) {
    constexpr std::string_view text = R"SQL(
with source as (
    select /*String(C5FA)*/ as value
)
(select count() from source where 1 > (/*Integer(4888)*/))
limit /*Integer(FCD0)*/
)SQL";

    auto script = ParseString(text);

    EXPECT_TRUE(script->errors.empty());
    ASSERT_EQ(script->statements.size(), 1u);
    EXPECT_EQ(script->statements.front().type, buffers::parser::StatementType::SELECT);
}

TEST(ParserTest, FormatsLogQueryWithCtesAndFunctionArguments) {
    constexpr std::string_view input = R"SQL(WITH events AS (
  SELECT
    ts_new,
    k,
    json_extract_scalar(_event, '$.ctx["query-id"]') AS qid,
    element_at(v, 'transfer-mode') AS transfer_mode,
    json_extract_scalar(_event, '$.ctx.workload.name') AS workload
  FROM logs
  WHERE ts_date IN ('20260805', '20260806', '20260807', '20260808', '20260809', '20260810', '20260811')
    AND _falcon_instance = 'aws-prod1-useast1'
    AND _functional_domain = 'cdp1'
    AND k IN ('query-end', 'grpc-query-info-end', 'grpc-query-end', 'query-status-written')
    AND json_extract_scalar(_event, '$.ctx["query-id"]') IS NOT NULL
),
per_qid AS (
  SELECT
    qid,
    max(CASE WHEN k = 'grpc-query-end' THEN transfer_mode END) AS transfer_mode,
    max(CASE WHEN k = 'grpc-query-end' THEN workload END) AS workload,
    max(CASE WHEN k = 'grpc-query-info-end' THEN ts_new END) AS last_info_end,
    max(CASE WHEN k = 'query-end' THEN ts_new END) AS query_end_t,
    max(CASE WHEN k = 'query-status-written' THEN ts_new END) AS status_written_t,
    count_if(k = 'grpc-query-info-end') AS info_calls,
    count_if(k = 'query-end') AS query_end_calls
  FROM events
  GROUP BY qid
)
SELECT
  qid,
  transfer_mode,
  workload,
  info_calls,
  date_diff('millisecond', last_info_end, query_end_t) / 1000.0 AS delta_s,
  last_info_end,
  query_end_t,
  status_written_t
FROM per_qid
WHERE query_end_calls > 0
  AND last_info_end IS NOT NULL
  AND last_info_end < query_end_t
ORDER BY delta_s DESC)SQL";
    auto script = ParseString(input);
    buffers::formatting::FormattingConfigT config;
    config.dialect = buffers::formatting::FormattingDialect::TRINO;
    config.mode = buffers::formatting::FormattingMode::COMPACT;
    config.max_width = 120;
    config.indentation_width = 2;

    Formatter formatter{*script};
    EXPECT_EQ(formatter.Format(config), R"SQL(with events as (
  select ts_new, k, json_extract_scalar(_event, '$.ctx["query-id"]') as qid,
    element_at(v, 'transfer-mode') as transfer_mode, json_extract_scalar(_event, '$.ctx.workload.name') as workload
  from logs
  where ts_date in ('20260805', '20260806', '20260807', '20260808', '20260809', '20260810', '20260811')
    and _falcon_instance = 'aws-prod1-useast1' and _functional_domain = 'cdp1'
    and k in ('query-end', 'grpc-query-info-end', 'grpc-query-end', 'query-status-written')
    and json_extract_scalar(_event, '$.ctx["query-id"]') is not null
), per_qid as (
  select qid, max(case when k = 'grpc-query-end' then transfer_mode end) as transfer_mode,
    max(case when k = 'grpc-query-end' then workload end) as workload,
    max(case when k = 'grpc-query-info-end' then ts_new end) as last_info_end,
    max(case when k = 'query-end' then ts_new end) as query_end_t,
    max(case when k = 'query-status-written' then ts_new end) as status_written_t,
    count_if(k = 'grpc-query-info-end') as info_calls, count_if(k = 'query-end') as query_end_calls
  from events
  group by qid
)
select qid, transfer_mode, workload, info_calls,
  date_diff('millisecond', last_info_end, query_end_t) / 1000.0 as delta_s, last_info_end, query_end_t,
  status_written_t
from per_qid
where query_end_calls > 0 and last_info_end is not null and last_info_end < query_end_t
order by delta_s desc;)SQL");
    EXPECT_TRUE(formatter.IsFullyFormatted());
}

TEST(ParserTest, RestoresCapturedPrefixStateStack) {
    constexpr std::string_view text = "WITH source AS (SELECT 1) SELECT * FROM source";
    rope::Rope buffer{128};
    buffer.Insert(0, text);
    auto scanned = Scanner::Scan(buffer, 0, 2);
    auto& symbols = scanned->GetSymbols();
    ChunkBufferEntryID cursor{0, 0};
    while (!symbols.IsAtEOF(cursor) && symbols[cursor].location.offset() < text.find("source", 5)) {
        cursor = symbols.GetNext(cursor);
    }

    auto expected = Parser::ParseUntilWithSnapshot(*scanned, cursor);
    ASSERT_TRUE(expected.prefix.reached_target);
    ASSERT_FALSE(expected.prefix.state_stack.empty());

    ParseContext context{*scanned};
    Parser parser{context};
    parser.RestorePrefix(expected.prefix);
    ASSERT_EQ(parser.GetStackSize(), expected.prefix.state_stack.size());
    for (size_t i = 0; i < expected.prefix.state_stack.size(); ++i) {
        EXPECT_EQ(parser.GetStackState(i), expected.prefix.state_stack[expected.prefix.state_stack.size() - 1 - i]);
    }
}

TEST(ParserTest, DetectsParsedScriptFeatures) {
    auto plain = ParseString("SELECT '|>' AS operator_text");
    EXPECT_EQ(plain->feature_flags, 0u);

    auto visualize = ParseString("SELECT 1 VISUALIZE USING vegalite (mark => bar)");
    EXPECT_EQ(visualize->feature_flags, static_cast<uint32_t>(buffers::parser::ParsedScriptFeature::VISUALIZE));

}

TEST(ParserTest, ParsesGraphPatternQuantifiers) {
    auto script = ParseString(R"SQL(
WITH pg AS PROPERTY GRAPH ()
SELECT * FROM GRAPH_TABLE(
    pg MATCH -[]->{2}, -[]->{1,2}, -[]->{,2}, -[]->{2,}, -[]->{,}
)
)SQL");
    EXPECT_TRUE(script->errors.empty()) << (script->errors.empty() ? "" : script->errors.front().message);
}

TEST(ParserTest, RejectsWhitespaceInsideGraphEdgeOperators) {
    auto script = ParseString(
        "WITH pg AS PROPERTY GRAPH () SELECT * FROM GRAPH_TABLE(pg MATCH - [e:Edge]->)");
    ASSERT_FALSE(script->errors.empty());
    EXPECT_NE(script->errors.front().message.find("-["), std::string::npos);
}

TEST(ParserTest, ParsesTrailingVisualization) {
    constexpr std::string_view input = R"SQL(
SELECT * FROM sales WHERE revenue > 0
VISUALIZE USING vegalite (mark => bar)
)SQL";

    auto script = ParseString(input);
    EXPECT_TRUE(script->errors.empty()) << (script->errors.empty() ? "" : script->errors.front().message);
    ASSERT_EQ(script->statements.size(), 1u);
    EXPECT_EQ(script->statements.front().type, buffers::parser::StatementType::VIS_VISUALISE);

    auto& root = script->nodes[script->statements.front().root];
    ASSERT_EQ(root.node_type(), buffers::parser::NodeType::OBJECT_VIS_VISUALISE);
    auto source = std::find_if(
        script->nodes.begin() + root.children_begin_or_value(),
        script->nodes.begin() + root.children_begin_or_value() + root.children_count(),
        [](const auto& node) { return node.attribute_key() == buffers::parser::AttributeKey::VIS_VISUALISE_SELECT; });
    ASSERT_NE(source, script->nodes.end());
    EXPECT_EQ(source->node_type(), buffers::parser::NodeType::OBJECT_SQL_SELECT);
}

}  // namespace
