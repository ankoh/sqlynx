#include "sqlynx/parser/scanner.h"

#include <initializer_list>
#include <optional>

#include "gtest/gtest.h"
#include "sqlynx/api.h"
#include "sqlynx/external.h"
#include "sqlynx/parser/parser.h"
#include "sqlynx/proto/proto_generated.h"
#include "sqlynx/script.h"

using namespace sqlynx;

using ScannerToken = proto::ScannerTokenType;

namespace {

constexpr auto OK = static_cast<uint32_t>(proto::StatusCode::OK);

static void match_tokens(const void* data, const std::vector<uint32_t>& offsets, const std::vector<uint32_t>& lengths,
                         const std::vector<ScannerToken>& types, const std::vector<uint32_t>& breaks) {
    auto scanned = flatbuffers::GetRoot<proto::ScannedScript>(data);
    proto::ScannedScriptT unpacked;
    scanned->UnPackTo(&unpacked);
    ASSERT_EQ(unpacked.tokens->token_offsets, offsets);
    ASSERT_EQ(unpacked.tokens->token_lengths, lengths);
    ASSERT_EQ(unpacked.tokens->token_types, types);
    ASSERT_EQ(unpacked.tokens->token_breaks, breaks);
}

TEST(ScannerTest, InsertChars) {
    auto catalog_result = sqlynx_catalog_new();
    ASSERT_EQ(catalog_result->status_code, OK);
    auto catalog = catalog_result->CastOwnerPtr<Catalog>();
    auto script_result = sqlynx_script_new(catalog, 1);
    ASSERT_EQ(script_result->status_code, OK);
    auto script = script_result->CastOwnerPtr<Script>();

    size_t size = 0;
    auto add_char = [&](char c, std::vector<uint32_t> offsets, std::vector<uint32_t> lengths,
                        std::vector<proto::ScannerTokenType> types, std::vector<uint32_t> breaks) {
        sqlynx_script_insert_char_at(script, size++, c);
        auto result = sqlynx_script_scan(script);
        ASSERT_EQ(result->status_code, OK);
        match_tokens(result->data_ptr, offsets, lengths, types, breaks);
        sqlynx_delete_result(result);
    };

    add_char('s', {0}, {1}, {ScannerToken::IDENTIFIER}, {});
    add_char('e', {0}, {2}, {ScannerToken::IDENTIFIER}, {});
    add_char('l', {0}, {3}, {ScannerToken::IDENTIFIER}, {});
    add_char('e', {0}, {4}, {ScannerToken::IDENTIFIER}, {});
    add_char('c', {0}, {5}, {ScannerToken::IDENTIFIER}, {});
    add_char('t', {0}, {6}, {ScannerToken::KEYWORD}, {});
    add_char('\n', {0}, {6}, {ScannerToken::KEYWORD}, {1});
    add_char('1', {0, 7}, {6, 1}, {ScannerToken::KEYWORD, ScannerToken::LITERAL_INTEGER}, {1});

    sqlynx_delete_result(script_result);
    sqlynx_delete_result(catalog_result);
}

TEST(ScannerTest, FindTokenAtOffset) {
    std::shared_ptr<ScannedScript> script;

    // Helper to scan a script
    auto scan = [&](std::string_view text, ExternalID external_id) {
        rope::Rope buffer{128};
        buffer.Insert(0, text);
        auto [scanned, status] = parser::Scanner::Scan(buffer, external_id);
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
    using Relative = ScannedScript::LocationInfo::RelativePosition;
    auto test_symbol = [&](size_t text_offset, size_t exp_token_id, Relative relative) {
        auto location = script->FindSymbol(text_offset);
        ASSERT_EQ(location.symbol_id, exp_token_id) << text_offset;
        ASSERT_EQ(location.relative_pos, relative) << text_offset;
    };

    {
        SCOPED_TRACE("empty");
        scan("", 0);
        test_tokens({});
        test_symbol(0, 0, Relative::NEW_SYMBOL_BEFORE);
    }
    {
        SCOPED_TRACE("only space");
        scan("    ", 0);
        test_tokens({});
        test_symbol(0, 0, Relative::NEW_SYMBOL_BEFORE);
    }
    {
        SCOPED_TRACE("select 1");
        scan("select 1", 1);
        test_tokens({ScannerToken::KEYWORD, ScannerToken::LITERAL_INTEGER});
        test_symbol(0, 0, Relative::BEGIN_OF_SYMBOL);
        test_symbol(1, 0, Relative::MID_OF_SYMBOL);
        test_symbol(2, 0, Relative::MID_OF_SYMBOL);
        test_symbol(3, 0, Relative::MID_OF_SYMBOL);
        test_symbol(4, 0, Relative::MID_OF_SYMBOL);
        test_symbol(5, 0, Relative::MID_OF_SYMBOL);
        test_symbol(6, 0, Relative::END_OF_SYMBOL);
        test_symbol(7, 1, Relative::BEGIN_OF_SYMBOL);
        test_symbol(8, 1, Relative::END_OF_SYMBOL);
        test_symbol(9, 1, Relative::END_OF_SYMBOL);
        test_symbol(10, 1, Relative::END_OF_SYMBOL);
        test_symbol(100, 1, Relative::END_OF_SYMBOL);
    }
    {
        SCOPED_TRACE("select 1, trailing space");
        test_tokens({ScannerToken::KEYWORD, ScannerToken::LITERAL_INTEGER});
        test_symbol(8, 1, Relative::END_OF_SYMBOL);
    }
    {
        SCOPED_TRACE("select a from A where b = 1");
        scan("select a from A where b = 1", 1);
        test_tokens({ScannerToken::KEYWORD, ScannerToken::IDENTIFIER, ScannerToken::KEYWORD, ScannerToken::IDENTIFIER,
                     ScannerToken::KEYWORD, ScannerToken::IDENTIFIER, ScannerToken::OPERATOR,
                     ScannerToken::LITERAL_INTEGER});
        test_symbol(0, 0, Relative::BEGIN_OF_SYMBOL);
        test_symbol(1, 0, Relative::MID_OF_SYMBOL);
        test_symbol(2, 0, Relative::MID_OF_SYMBOL);
        test_symbol(3, 0, Relative::MID_OF_SYMBOL);
        test_symbol(4, 0, Relative::MID_OF_SYMBOL);
        test_symbol(5, 0, Relative::MID_OF_SYMBOL);
        test_symbol(6, 0, Relative::END_OF_SYMBOL);
        test_symbol(7, 1, Relative::BEGIN_OF_SYMBOL);
        test_symbol(8, 1, Relative::END_OF_SYMBOL);
        test_symbol(9, 2, Relative::BEGIN_OF_SYMBOL);
        test_symbol(10, 2, Relative::MID_OF_SYMBOL);
        test_symbol(11, 2, Relative::MID_OF_SYMBOL);
        test_symbol(12, 2, Relative::MID_OF_SYMBOL);
        test_symbol(13, 2, Relative::END_OF_SYMBOL);
        test_symbol(14, 3, Relative::BEGIN_OF_SYMBOL);
        test_symbol(15, 3, Relative::END_OF_SYMBOL);
        test_symbol(16, 4, Relative::BEGIN_OF_SYMBOL);
        test_symbol(17, 4, Relative::MID_OF_SYMBOL);
        test_symbol(18, 4, Relative::MID_OF_SYMBOL);
        test_symbol(19, 4, Relative::MID_OF_SYMBOL);
        test_symbol(20, 4, Relative::MID_OF_SYMBOL);
        test_symbol(21, 4, Relative::END_OF_SYMBOL);
        test_symbol(22, 5, Relative::BEGIN_OF_SYMBOL);
        test_symbol(23, 5, Relative::END_OF_SYMBOL);
        test_symbol(24, 6, Relative::BEGIN_OF_SYMBOL);
        test_symbol(25, 6, Relative::END_OF_SYMBOL);
        test_symbol(26, 7, Relative::BEGIN_OF_SYMBOL);
        test_symbol(27, 7, Relative::END_OF_SYMBOL);
        test_symbol(28, 7, Relative::END_OF_SYMBOL);
        test_symbol(30, 7, Relative::END_OF_SYMBOL);
        test_symbol(100, 7, Relative::END_OF_SYMBOL);
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
        auto hit = scanned->FindSymbol(i * 2);
        ASSERT_EQ(hit.symbol_id, i);
        auto one_off = scanned->FindSymbol(i * 2 + 1);
        ASSERT_EQ(one_off.symbol_id, i);
    }
}

TEST(ScannerTest, TrailingComments) {
    rope::Rope buffer{128};
    buffer.Insert(0, R"SQL(
        select 1
        --
    )SQL");
    auto [scanned, status] = parser::Scanner::Scan(buffer, 0);
    ASSERT_EQ(status, proto::StatusCode::OK);
    auto packed = scanned->PackTokens();
    ASSERT_EQ(packed->token_types.size(), 3);
}

}  // namespace
