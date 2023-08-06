#include "flatsql/parser/scanner.h"

#include <initializer_list>
#include <optional>

#include "flatsql/api.h"
#include "flatsql/parser/parser_generated.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"
#include "gtest/gtest.h"

using namespace flatsql;

using Token = proto::ScannerTokenType;

namespace {

constexpr auto OK = static_cast<uint32_t>(proto::StatusCode::OK);

static void match_tokens(const void* data, const std::vector<uint32_t>& offsets, const std::vector<uint32_t>& lengths,
                         const std::vector<Token>& types, const std::vector<uint32_t>& breaks) {
    auto scanned = flatbuffers::GetRoot<proto::ScannedScript>(data);
    proto::ScannedScriptT unpacked;
    scanned->UnPackTo(&unpacked);
    ASSERT_EQ(unpacked.tokens->token_offsets, offsets);
    ASSERT_EQ(unpacked.tokens->token_lengths, lengths);
    ASSERT_EQ(unpacked.tokens->token_types, types);
    ASSERT_EQ(unpacked.tokens->token_breaks, breaks);
}

TEST(ScannerTest, InsertChars) {
    auto script = flatsql_script_new();
    FFIResult* result = nullptr;

    size_t size = 0;
    auto add_char = [&](char c, std::vector<uint32_t> offsets, std::vector<uint32_t> lengths,
                        std::vector<proto::ScannerTokenType> types, std::vector<uint32_t> breaks) {
        flatsql_script_insert_char_at(script, size++, c);
        result = flatsql_script_scan(script);
        ASSERT_EQ(result->status_code, OK);
        match_tokens(result->data_ptr, offsets, lengths, types, breaks);
        flatsql_result_delete(result);
    };

    add_char('s', {0}, {1}, {Token::IDENTIFIER}, {});
    add_char('e', {0}, {2}, {Token::IDENTIFIER}, {});
    add_char('l', {0}, {3}, {Token::IDENTIFIER}, {});
    add_char('e', {0}, {4}, {Token::IDENTIFIER}, {});
    add_char('c', {0}, {5}, {Token::IDENTIFIER}, {});
    add_char('t', {0}, {6}, {Token::KEYWORD}, {});
    add_char('\n', {0}, {6}, {Token::KEYWORD}, {1});
    add_char('1', {0, 7}, {6, 1}, {Token::KEYWORD, Token::LITERAL_INTEGER}, {1});

    flatsql_script_delete(script);
}

TEST(ScannerTest, FindTokenAtOffset) {
    std::shared_ptr<ScannedScript> script;

    // Helper to scan a script
    auto scan = [&](std::string_view text) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto [scanned, status] = parser::Scanner::Scan(buffer);
        ASSERT_EQ(status, proto::StatusCode::OK);
        script = std::move(scanned);
    };
    // Test if token types match
    auto test_tokens = [&](std::initializer_list<proto::ScannerTokenType> tokens) {
        auto packed = script->PackTokens();
        std::vector<proto::ScannerTokenType> have_types{std::move(tokens)};
        ASSERT_EQ(packed->token_types, have_types);
    };
    // Test token at offset
    auto test_token_at_offset = [&](size_t text_offset, std::optional<size_t> expected_token_offset) {
        auto offset = script->FindTokenAtOffset(text_offset);
        ASSERT_EQ(offset, expected_token_offset) << text_offset;
    };

    {
        SCOPED_TRACE("select 1");
        scan("select 1");
        test_tokens({Token::KEYWORD, Token::LITERAL_INTEGER});
        test_token_at_offset(0, 0);
        test_token_at_offset(1, 0);
        test_token_at_offset(2, 0);
        test_token_at_offset(3, 0);
        test_token_at_offset(4, 0);
        test_token_at_offset(5, 0);
        test_token_at_offset(6, std::nullopt);
        test_token_at_offset(7, 1);
        test_token_at_offset(8, std::nullopt);
        test_token_at_offset(9, std::nullopt);
    }
    {
        SCOPED_TRACE("select a from A where b = 1");
        scan("select a from A where b = 1");
        test_tokens({Token::KEYWORD, Token::IDENTIFIER, Token::KEYWORD, Token::IDENTIFIER, Token::KEYWORD,
                     Token::IDENTIFIER, Token::OPERATOR, Token::LITERAL_INTEGER});
        test_token_at_offset(0, 0);
        test_token_at_offset(1, 0);
        test_token_at_offset(2, 0);
        test_token_at_offset(3, 0);
        test_token_at_offset(4, 0);
        test_token_at_offset(5, 0);
        test_token_at_offset(6, std::nullopt);
        test_token_at_offset(7, 1);
        test_token_at_offset(8, std::nullopt);
        test_token_at_offset(9, 2);
        test_token_at_offset(10, 2);
        test_token_at_offset(11, 2);
        test_token_at_offset(12, 2);
        test_token_at_offset(13, std::nullopt);
        test_token_at_offset(14, 3);
        test_token_at_offset(15, std::nullopt);
        test_token_at_offset(16, 4);
        test_token_at_offset(17, 4);
        test_token_at_offset(18, 4);
        test_token_at_offset(19, 4);
        test_token_at_offset(20, 4);
        test_token_at_offset(21, std::nullopt);
        test_token_at_offset(22, 5);
        test_token_at_offset(23, std::nullopt);
        test_token_at_offset(24, 6);
        test_token_at_offset(25, std::nullopt);
        test_token_at_offset(26, 7);
        test_token_at_offset(27, std::nullopt);
    }
}

}  // namespace
