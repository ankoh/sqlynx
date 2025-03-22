#include <initializer_list>

#include "gtest/gtest.h"
#include "dashql/analyzer/analyzer.h"
#include "dashql/catalog.h"
#include "dashql/parser/parser.h"
#include "dashql/parser/scanner.h"
#include "dashql/buffers/index_generated.h"
#include "dashql/script.h"
#include "dashql/text/names.h"

using namespace dashql;

namespace {

std::string snapshot(const decltype(ScannedScript::name_registry)& names) {
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
    ASSERT_EQ(scan_status, buffers::StatusCode::OK);
    auto [parsed, parser_status] = parser::Parser::Parse(scanned);
    ASSERT_EQ(parser_status, buffers::StatusCode::OK);
    ASSERT_TRUE(parsed->errors.empty()) << parsed->errors[0].second;
    Catalog catalog;
    auto [analyzed, analyzer_status] = Analyzer::Analyze(parsed, catalog);
    ASSERT_EQ(analyzer_status, buffers::StatusCode::OK);

    ASSERT_EQ(scanned->name_registry.GetSize(), GetParam().expected.size()) << snapshot(scanned->name_registry);
    size_t i = 0;
    for (auto [name, tags] : GetParam().expected) {
        SCOPED_TRACE(i);
        size_t current = i++;
        auto& have = scanned->name_registry.At(current);
        ASSERT_EQ(have.text, name);
        ASSERT_EQ(static_cast<uint64_t>(have.coarse_analyzer_tags), static_cast<uint64_t>(tags));
    }
}

std::vector<NameTaggingTest> TESTS_SIMPLE{
    {"select_1",
     "select 1",
     {
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo",
     "select foo",
     {
         {"foo", NameTags(buffers::NameTag::COLUMN_NAME)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_from_bar",
     "select foo from bar",
     {
         {"foo", NameTags(buffers::NameTag::COLUMN_NAME)},
         {"bar", NameTags(buffers::NameTag::TABLE_NAME)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_from_foo",
     "select foo from foo",
     {
         {"foo", NameTags(buffers::NameTag::COLUMN_NAME) | buffers::NameTag::TABLE_NAME},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_from_foo_foo",
     "select foo from foo foo",
     {
         {"foo", NameTags(buffers::NameTag::COLUMN_NAME) | buffers::NameTag::TABLE_NAME | buffers::NameTag::TABLE_ALIAS},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_from_foo_bar",
     "select foo from foo bar",
     {
         {"foo", NameTags(buffers::NameTag::COLUMN_NAME) | buffers::NameTag::TABLE_NAME},
         {"bar", NameTags(buffers::NameTag::TABLE_ALIAS)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_bar_from_the_foo",
     "select foo.bar from the foo",
     {
         {"foo", NameTags(buffers::NameTag::TABLE_ALIAS)},
         {"bar", NameTags(buffers::NameTag::COLUMN_NAME)},
         {"the", NameTags(buffers::NameTag::TABLE_NAME)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_bar_from_the_real_foo",
     "select foo.bar from the.real foo",
     {
         {"foo", NameTags(buffers::NameTag::TABLE_ALIAS)},
         {"bar", NameTags(buffers::NameTag::COLUMN_NAME)},
         {"the", NameTags(buffers::NameTag::SCHEMA_NAME)},
         {"real", NameTags(buffers::NameTag::TABLE_NAME)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"select_foo_bar_from_the_actually_real_foo",
     "select foo.bar from the.actually.real foo",
     {
         {"foo", NameTags(buffers::NameTag::TABLE_ALIAS)},
         {"bar", NameTags(buffers::NameTag::COLUMN_NAME)},
         {"the", NameTags(buffers::NameTag::DATABASE_NAME)},
         {"actually", NameTags(buffers::NameTag::SCHEMA_NAME)},
         {"real", NameTags(buffers::NameTag::TABLE_NAME)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }},
    {"quoted_identifier",
     "select * from \"SomeQuotedString\"",
     {
         {"SomeQuotedString", NameTags(buffers::NameTag::TABLE_NAME)},
         {Catalog::DEFAULT_DATABASE_NAME, NameTags(buffers::NameTag::DATABASE_NAME)},
         {Catalog::DEFAULT_SCHEMA_NAME, NameTags(buffers::NameTag::SCHEMA_NAME)},
     }}};

INSTANTIATE_TEST_SUITE_P(SimpleNameTagging, TestNameTags, ::testing::ValuesIn(TESTS_SIMPLE), NameTaggingTestPrinter());

}  // namespace
