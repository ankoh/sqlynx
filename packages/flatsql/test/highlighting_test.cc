#include <initializer_list>

#include "flatsql/api.h"
#include "flatsql/proto/proto_generated.h"
#include "gtest/gtest.h"

using namespace flatsql;

using Token = proto::HighlightingTokenType;

namespace {

constexpr auto OK = static_cast<uint32_t>(proto::StatusCode::OK);

static void match_tokens(const void* data, const std::vector<uint32_t>& offsets, const std::vector<Token>& types,
                         const std::vector<uint32_t>& breaks) {
    auto scanned = flatbuffers::GetRoot<proto::ScannedScript>(data);
    proto::ScannedScriptT unpacked;
    scanned->UnPackTo(&unpacked);
    ASSERT_EQ(unpacked.highlighting->token_offsets, offsets);
    ASSERT_EQ(unpacked.highlighting->token_types, types);
    ASSERT_EQ(unpacked.highlighting->token_breaks, breaks);
}

TEST(HighlightingTest, InsertChars) {
    auto script = flatsql_script_new();
    FFIResult* result = nullptr;

    size_t size = 0;
    auto add_char = [&](char c, std::vector<uint32_t> offsets, std::vector<proto::HighlightingTokenType> types,
                        std::vector<uint32_t> breaks) {
        flatsql_script_insert_char_at(script, size++, c);
        result = flatsql_script_scan(script);
        ASSERT_EQ(result->status_code, OK);
        match_tokens(result->data_ptr, offsets, types, breaks);
        flatsql_result_delete(result);
    };

    add_char('s', {0, 1}, {Token::IDENTIFIER, Token::NONE}, {});
    add_char('e', {0, 2}, {Token::IDENTIFIER, Token::NONE}, {});
    add_char('l', {0, 3}, {Token::IDENTIFIER, Token::NONE}, {});
    add_char('e', {0, 4}, {Token::IDENTIFIER, Token::NONE}, {});
    add_char('c', {0, 5}, {Token::IDENTIFIER, Token::NONE}, {});
    add_char('t', {0, 6}, {Token::KEYWORD, Token::NONE}, {});
    add_char('\n', {0, 6}, {Token::KEYWORD, Token::NONE}, {1});
    add_char('1', {0, 6, 7, 8}, {Token::KEYWORD, Token::NONE, Token::LITERAL_INTEGER, Token::NONE}, {1});

    flatsql_script_delete(script);
}

}  // namespace
