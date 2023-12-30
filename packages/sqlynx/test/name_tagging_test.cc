#include <initializer_list>

#include "gtest/gtest.h"
#include "sqlynx/analyzer/analyzer.h"
#include "sqlynx/api.h"
#include "sqlynx/catalog.h"
#include "sqlynx/parser/names.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/parser/scanner.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

using namespace sqlynx;

namespace {

std::string snapshot(const decltype(ScannedScript::names)& names) {
    std::stringstream out;
    size_t i = 0;
    out << "[";
    for (auto& name_chunk : names.GetChunks()) {
        for (auto& name : name_chunk) {
            if (i++ > 0) {
                out << ", ";
            }
            out << name.text;
        }
    }
    out << "]";
    return out.str();
}

struct NameTaggingTest {
    std::string_view title;
    std::string_view script;
    std::vector<std::pair<std::string_view, NameTags>> expected;

    NameTaggingTest(std::string_view title, std::string_view script,
                    std::initializer_list<std::pair<std::string_view, NameTags>> expected)
        : title(title), script(script), expected(expected) {}
};

void operator<<(std::ostream& out, const NameTaggingTest& p) { out << p.title; }

struct NameTaggingTestPrinter {
    std::string operator()(const ::testing::TestParamInfo<NameTaggingTest>& info) const {
        return std::string{info.param.title};
    }
};

struct TestNameTags : public ::testing::TestWithParam<NameTaggingTest> {};

TEST_P(TestNameTags, Test) {
    rope::Rope buffer{128};
    buffer.Insert(0, GetParam().script);

    auto [scanned, scan_status] = parser::Scanner::Scan(buffer, 0);
    ASSERT_EQ(scan_status, proto::StatusCode::OK);
    auto [parsed, parser_status] = parser::Parser::Parse(scanned);
    ASSERT_EQ(parser_status, proto::StatusCode::OK);
    ASSERT_TRUE(parsed->errors.empty()) << parsed->errors[0].second;
    Catalog catalog;
    auto [analyzed, analyzer_status] = Analyzer::Analyze(parsed, catalog);
    ASSERT_EQ(analyzer_status, proto::StatusCode::OK);

    ASSERT_EQ(scanned->names.GetSize(), GetParam().expected.size()) << snapshot(scanned->names);
    size_t i = 0;
    for (auto [name, tags] : GetParam().expected) {
        SCOPED_TRACE(i);
        size_t current = i++;
        auto& have = scanned->ReadName(current);
        ASSERT_EQ(have.text, name);
        ASSERT_EQ(static_cast<uint64_t>(have.tags), static_cast<uint64_t>(tags));
    }
}

std::vector<NameTaggingTest> TESTS_SIMPLE{
    {"select_1", "select 1", {}},
    {"select_foo", "select foo", {{"foo", NameTags(proto::NameTag::COLUMN_NAME)}}},
    {"select_foo_from_bar",
     "select foo from bar",
     {
         {"foo", NameTags(proto::NameTag::COLUMN_NAME)},
         {"bar", NameTags(proto::NameTag::TABLE_NAME)},
     }},
    {"select_foo_from_foo",
     "select foo from foo",
     {
         {"foo", NameTags(proto::NameTag::COLUMN_NAME) | proto::NameTag::TABLE_NAME},
     }},
    {"select_foo_from_foo_foo",
     "select foo from foo foo",
     {
         {"foo", NameTags(proto::NameTag::COLUMN_NAME) | proto::NameTag::TABLE_NAME | proto::NameTag::TABLE_ALIAS},
     }},
    {"select_foo_from_foo_bar",
     "select foo from foo bar",
     {
         {"foo", NameTags(proto::NameTag::COLUMN_NAME) | proto::NameTag::TABLE_NAME},
         {"bar", NameTags(proto::NameTag::TABLE_ALIAS)},
     }},
    {"select_foo_bar_from_the_foo",
     "select foo.bar from the foo",
     {
         {"foo", NameTags(proto::NameTag::TABLE_ALIAS)},
         {"bar", NameTags(proto::NameTag::COLUMN_NAME)},
         {"the", NameTags(proto::NameTag::TABLE_NAME)},
     }},
    {"select_foo_bar_from_the_real_foo",
     "select foo.bar from the.real foo",
     {
         {"foo", NameTags(proto::NameTag::TABLE_ALIAS)},
         {"bar", NameTags(proto::NameTag::COLUMN_NAME)},
         {"the", NameTags(proto::NameTag::SCHEMA_NAME)},
         {"real", NameTags(proto::NameTag::TABLE_NAME)},
     }},
    {"select_foo_bar_from_the_actually_real_foo",
     "select foo.bar from the.actually.real foo",
     {
         {"foo", NameTags(proto::NameTag::TABLE_ALIAS)},
         {"bar", NameTags(proto::NameTag::COLUMN_NAME)},
         {"the", NameTags(proto::NameTag::DATABASE_NAME)},
         {"actually", NameTags(proto::NameTag::SCHEMA_NAME)},
         {"real", NameTags(proto::NameTag::TABLE_NAME)},
     }},
    {"quoted_identifier",
     "select * from \"SomeQuotedString\"",
     {{"SomeQuotedString", NameTags(proto::NameTag::TABLE_NAME)}}}};

INSTANTIATE_TEST_SUITE_P(SimpleNameTagging, TestNameTags, ::testing::ValuesIn(TESTS_SIMPLE), NameTaggingTestPrinter());

}  // namespace
