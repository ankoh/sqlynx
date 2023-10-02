#include "flatsql/parser/parser.h"

#include <initializer_list>
#include <optional>
#include <sstream>

#include "flatsql/api.h"
#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;
using namespace flatsql::parser;

using ScannerToken = proto::ScannerTokenType;
using ParserSymbol = Parser::symbol_kind_type;

namespace {

TEST(ParserTest, FindNodeAtOffset) {
    std::shared_ptr<ParsedScript> script;

    // Helper to parse a script
    auto parse = [&](std::string_view text) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto [scanned, scannerStatus] = Scanner::Scan(buffer, 2);
        ASSERT_EQ(scannerStatus, proto::StatusCode::OK);
        auto [parsed, parserStatus] = Parser::Parse(scanned);
        ASSERT_EQ(parserStatus, proto::StatusCode::OK);
        script = std::move(parsed);
    };
    /// Test if ast node matches
    auto test_node_at_offset = [&](size_t text_offset, size_t expected_statement_id, proto::NodeType expect_node_type,
                                   sx::Location expect_loc) {
        auto result = script->FindNodeAtOffset(text_offset);
        ASSERT_TRUE(result.has_value()) << "offset=" << text_offset;
        auto [statement_id, node_id] = *result;
        ASSERT_EQ(statement_id, expected_statement_id);
        ASSERT_LT(node_id, script->nodes.size());
        auto& node = script->nodes[node_id];
        ASSERT_EQ(node.node_type(), expect_node_type);
        ASSERT_EQ(node.location().offset(), expect_loc.offset());
        ASSERT_EQ(node.location().length(), expect_loc.length());
    };

    parse("select 1");
    test_node_at_offset(0, 0, proto::NodeType::OBJECT_SQL_SELECT, sx::Location(0, 8));
    test_node_at_offset(1, 0, proto::NodeType::OBJECT_SQL_SELECT, sx::Location(0, 8));
    test_node_at_offset(2, 0, proto::NodeType::OBJECT_SQL_SELECT, sx::Location(0, 8));
    test_node_at_offset(7, 0, proto::NodeType::LITERAL_INTEGER, sx::Location(7, 1));
}

struct ExpectedToken {
    size_t token_id;
    ParserSymbol symbol_type;

    ExpectedToken(size_t token_id, ParserSymbol symbol_type) : token_id(token_id), symbol_type(symbol_type) {}
};

struct CompletionTest {
    std::string_view title;
    std::string_view script;
    size_t token_count;
    ExpectedToken token;
    std::vector<ParserSymbol> expected_symbols;

    CompletionTest(std::string_view title, std::string_view script, size_t token_count, ExpectedToken token,
                   std::initializer_list<ParserSymbol> expected_symbols)
        : title(title),
          script(script),
          token_count(token_count),
          token(token),
          expected_symbols(std::move(expected_symbols)) {}
};

void operator<<(std::ostream& out, const CompletionTest& p) { out << p.title; }

struct CompletionTestPrinter {
    std::string operator()(const ::testing::TestParamInfo<CompletionTest>& info) const {
        return std::string{info.param.title};
    }
};

struct CompletionTestSuite : public ::testing::TestWithParam<CompletionTest> {};

TEST_P(CompletionTestSuite, Test) {
    auto& param = GetParam();
    rope::Rope buffer{128};
    buffer.Insert(0, param.script);

    auto [scan, scan_status] = Scanner::Scan(buffer, 1);
    ASSERT_EQ(scan_status, proto::StatusCode::OK);
    ASSERT_EQ(scan->GetSymbols().GetSize(), param.token_count);
    ASSERT_LT(param.token.token_id, scan->GetSymbols().GetSize());
    ASSERT_EQ(scan->GetSymbols()[param.token.token_id].kind_, param.token.symbol_type);

    auto result = parser::Parser::ParseUntil(*scan, param.token.token_id);
    ASSERT_EQ(result, param.expected_symbols);
}

std::vector<CompletionTest> TESTS{
    {"empty",
     "",
     1,
     {0, ParserSymbol::S_YYEOF},
     {
         ParserSymbol::S_YYEOF, Parser::symbol_kind_type::S_WITH_LA, Parser::symbol_kind_type::S_VALUES,
         ParserSymbol::S_CREATE_P, Parser::symbol_kind_type::S_SELECT, Parser::symbol_kind_type::S_TABLE,
         ParserSymbol::S_WITH, Parser::symbol_kind_type::S_SET, Parser::symbol_kind_type::S_472_ /* ( */
     }},
    {"group",
     "select * from region group",
     6,
     {4, ParserSymbol::S_GROUP_P},
     {
         ParserSymbol::S_SCONST, parser::Parser::symbol_kind_type::S_PARAM, ParserSymbol::S_COLON_EQUALS,
         parser::Parser::symbol_kind_type::S_EQUALS_GREATER,
         ParserSymbol::S_472_,  // '('
         ParserSymbol::S_476_,  // '$'
         ParserSymbol::S_477_   // '?',
     }},
    {"group_by_eof",
     "select * from region group",
     6,
     {5, ParserSymbol::S_YYEOF},
     {
         ParserSymbol::S_BY,
     }},
    {"group_by",
     "select * from region group by",
     7,
     {5, ParserSymbol::S_BY},
     {
         ParserSymbol::S_BY,
     }}
    //
};

INSTANTIATE_TEST_SUITE_P(ParserCompletionTest, CompletionTestSuite, ::testing::ValuesIn(TESTS),
                         CompletionTestPrinter());

}  // namespace
