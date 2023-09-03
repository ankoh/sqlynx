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

void analyze(std::shared_ptr<AnalyzedScript>& out, rope::Rope& buffer, uint32_t context_id, std::string_view text) {
    buffer.Remove(0, buffer.GetStats().utf8_codepoints);
    buffer.Insert(0, text);
    auto [scanned, scan_status] = parser::Scanner::Scan(buffer, context_id);
    ASSERT_EQ(scan_status, proto::StatusCode::OK);
    auto [parsed, parser_status] = parser::ParseContext::Parse(scanned);
    ASSERT_EQ(parser_status, proto::StatusCode::OK);
    auto [analyzed, analyzer_status] = Analyzer::Analyze(parsed, nullptr);
    ASSERT_EQ(analyzer_status, proto::StatusCode::OK);
    out = analyzed;
}

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

void test_name_tags(const AnalyzedScript& analyzed,
                    std::initializer_list<std::pair<std::string_view, NameTags>> expected) {
    auto& scanned = *analyzed.parsed_script->scanned_script;
    ASSERT_EQ(scanned.name_dictionary.size(), expected.size()) << dump(scanned.name_dictionary);
    size_t i = 0;
    for (auto [name, tags] : expected) {
        auto& have = scanned.name_dictionary[i++];
        ASSERT_EQ(have.text, name);
        ASSERT_EQ(static_cast<uint64_t>(have.tags), static_cast<uint64_t>(tags));
    }
}

TEST(NameTaggingTest, Select1) {
    std::shared_ptr<AnalyzedScript> analyzed;
    rope::Rope buffer{128};

    ASSERT_NO_FATAL_FAILURE(analyze(analyzed, buffer, 0, "select 1"));
    ASSERT_NO_FATAL_FAILURE(test_name_tags(*analyzed, {{"", NameTags()}}));

    ASSERT_NO_FATAL_FAILURE(analyze(analyzed, buffer, 0, "select foo"));
    ASSERT_NO_FATAL_FAILURE(test_name_tags(*analyzed, {{"", NameTags()}, {"foo", proto::NameTag::COLUMN_NAME}}));
}

}  // namespace
