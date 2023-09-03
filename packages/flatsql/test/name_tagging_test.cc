#include <initializer_list>

#include "flatsql/analyzer/analyzer.h"
#include "flatsql/api.h"
#include "flatsql/parser/names.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;

namespace {

std::string dump(std::span<const ScannedScript::Name> names) {
    std::stringstream out;
    size_t i = 0;
    out << "[";
    for (auto& name : names) {
        if (i++ > 0) {
            out << ", ";
        }
        out << name.text;
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
    auto [parsed, parser_status] = parser::ParseContext::Parse(scanned);
    ASSERT_EQ(parser_status, proto::StatusCode::OK);
    auto [analyzed, analyzer_status] = Analyzer::Analyze(parsed, nullptr);
    ASSERT_EQ(analyzer_status, proto::StatusCode::OK);

    ASSERT_EQ(scanned->name_dictionary.size(), GetParam().expected.size()) << dump(scanned->name_dictionary);
    size_t i = 0;
    for (auto [name, tags] : GetParam().expected) {
        auto& have = scanned->name_dictionary[i++];
        ASSERT_EQ(have.text, name);
        ASSERT_EQ(static_cast<uint64_t>(have.tags), static_cast<uint64_t>(tags));
    }
}

std::vector<NameTaggingTest> TESTS_SIMPLE{
    {"select_1", "select 1", {}},
    {"select_foo", "select foo", {{"foo", NameTags() | proto::NameTag::COLUMN_NAME}}},
    {"select_foo_from_bar",
     "select foo from bar",
     {
         {"foo", NameTags() | proto::NameTag::COLUMN_NAME},
         {"bar", NameTags() | proto::NameTag::TABLE_NAME},
     }},
};

INSTANTIATE_TEST_SUITE_P(SimpleNameTagging, TestNameTags, ::testing::ValuesIn(TESTS_SIMPLE), NameTaggingTestPrinter());

}  // namespace
