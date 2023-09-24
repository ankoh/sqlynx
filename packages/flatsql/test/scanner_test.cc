#include "flatsql/parser/scanner.h"

#include <initializer_list>
#include <optional>

#include "flatsql/api.h"
#include "flatsql/parser/parser.h"
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
    auto script = flatsql_script_new(1);
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
    auto scan = [&](std::string_view text, uint32_t context_id) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto [scanned, status] = parser::Scanner::Scan(buffer, context_id);
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
    auto test_token_at_offset = [&](size_t text_offset, size_t expected_token_offset) {
        auto offset = script->FindToken(text_offset);
        ASSERT_EQ(offset, expected_token_offset) << text_offset;
    };

    {
        SCOPED_TRACE("select 1");
        scan("select 1", 1);
        test_tokens({Token::KEYWORD, Token::LITERAL_INTEGER});
        test_token_at_offset(0, 0);
        test_token_at_offset(1, 0);
        test_token_at_offset(2, 0);
        test_token_at_offset(3, 0);
        test_token_at_offset(4, 0);
        test_token_at_offset(5, 0);
        test_token_at_offset(6, 0);
        test_token_at_offset(7, 1);
        test_token_at_offset(8, 1);
        test_token_at_offset(9, 1);
        test_token_at_offset(10, 1);
        test_token_at_offset(100, 1);
    }
    {
        SCOPED_TRACE("select a from A where b = 1");
        scan("select a from A where b = 1", 1);
        test_tokens({Token::KEYWORD, Token::IDENTIFIER, Token::KEYWORD, Token::IDENTIFIER, Token::KEYWORD,
                     Token::IDENTIFIER, Token::OPERATOR, Token::LITERAL_INTEGER});
        test_token_at_offset(0, 0);
        test_token_at_offset(1, 0);
        test_token_at_offset(2, 0);
        test_token_at_offset(3, 0);
        test_token_at_offset(4, 0);
        test_token_at_offset(5, 0);
        test_token_at_offset(6, 0);
        test_token_at_offset(7, 1);
        test_token_at_offset(8, 1);
        test_token_at_offset(9, 2);
        test_token_at_offset(10, 2);
        test_token_at_offset(11, 2);
        test_token_at_offset(12, 2);
        test_token_at_offset(13, 2);
        test_token_at_offset(14, 3);
        test_token_at_offset(15, 3);
        test_token_at_offset(16, 4);
        test_token_at_offset(17, 4);
        test_token_at_offset(18, 4);
        test_token_at_offset(19, 4);
        test_token_at_offset(20, 4);
        test_token_at_offset(21, 4);
        test_token_at_offset(22, 5);
        test_token_at_offset(23, 5);
        test_token_at_offset(24, 6);
        test_token_at_offset(25, 6);
        test_token_at_offset(26, 7);
        test_token_at_offset(27, 7);
        test_token_at_offset(28, 7);
        test_token_at_offset(30, 7);
        test_token_at_offset(100, 7);
    }
}

TEST(ScannerTest, FindTokenInterleaved) {
    size_t n = 2048;
    std::stringstream ss;
    for (size_t i = 0; i < n; ++i) {
        ss << (i & 7);
        ss << " ";
    }
    rope::Rope buffer{128};
    buffer.Insert(0, ss.str());

    auto [scanned, scannerStatus] = parser::Scanner::Scan(buffer, 1);
    ASSERT_EQ(scannerStatus, proto::StatusCode::OK);

    for (size_t i = 0; i < n; ++i) {
        auto hit = scanned->FindToken(i * 2);
        ASSERT_EQ(hit, i);
        auto one_off = scanned->FindToken(i * 2 + 1);
        ASSERT_EQ(one_off, i);
    }
}

}  // namespace
