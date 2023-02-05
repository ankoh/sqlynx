#include <unordered_map>

#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/parser/scanner.h"
#include "flatsql/proto/proto_generated.h"

namespace flatsql {
namespace parser {

static const proto::HighlightingTokenType MapToken(Parser::symbol_kind_type symbol) {
    switch (symbol) {
#define X(CATEGORY, NAME, TOKEN) case Parser::symbol_kind_type::S_##TOKEN:
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
        return proto::HighlightingTokenType::KEYWORD;
        case Parser::symbol_kind_type::S_STRING_LITERAL:
        case Parser::symbol_kind_type::S_SCONST:
        case Parser::symbol_kind_type::S_USCONST:
            return proto::HighlightingTokenType::LITERAL_STRING;
        case Parser::symbol_kind_type::S_ICONST:
            return proto::HighlightingTokenType::LITERAL_INTEGER;
        case Parser::symbol_kind_type::S_FCONST:
            return proto::HighlightingTokenType::LITERAL_FLOAT;
        case Parser::symbol_kind_type::S_BCONST:
            return proto::HighlightingTokenType::LITERAL_BINARY;
        case Parser::symbol_kind_type::S_XCONST:
            return proto::HighlightingTokenType::LITERAL_HEX;
        case Parser::symbol_kind_type::S_BOOLEAN_LITERAL:
            return proto::HighlightingTokenType::LITERAL_BOOLEAN;
        case Parser::symbol_kind_type::S_Op:
            return proto::HighlightingTokenType::OPERATOR;
        case Parser::symbol_kind_type::S_IDENT:
        case Parser::symbol_kind_type::S_UIDENT:
        case Parser::symbol_kind_type::S_IDENTIFIER:
            return proto::HighlightingTokenType::IDENTIFIER;
        default:
            return proto::HighlightingTokenType::NONE;
    };
};

/// Collect syntax highlighting information
std::unique_ptr<proto::HighlightingT> Scanner::BuildHighlighting() {
    std::vector<uint32_t> offsets;
    std::vector<proto::HighlightingTokenType> types;

    // Emit highlighting tokens at a location.
    // We emit 2 tokens at the begin and the end of every location and overwrite types if the offsets equal.
    // That allows us to capture whitespace accurately for Monaco.
    auto emit = [&](proto::Location loc, proto::HighlightingTokenType type) {
        if (!offsets.empty() && offsets.back() == loc.offset()) {
            types.back() = type;
        } else {
            offsets.push_back(loc.offset());
            types.push_back(type);
        }
        offsets.push_back(loc.offset() + loc.length());
        types.push_back(proto::HighlightingTokenType::NONE);
    };

    auto ci = 0;
    for (auto& symbol : symbols_) {
        // Emit all comments in between.
        while (ci < comments_.size() && comments_[ci].offset() < symbol.location.offset()) {
            emit(comments_[ci++], proto::HighlightingTokenType::COMMENT);
        }
        // Is option key?
        if (dson_key_offsets_.count(symbol.location.offset())) {
            emit(symbol.location, proto::HighlightingTokenType::VARARG_KEY);
            continue;
        }
        // Map as standard token.
        emit(symbol.location, MapToken(symbol.kind()));
    }

    // Build the line breaks
    std::vector<uint32_t> breaks;
    auto oi = 0;
    for (auto& lb : line_breaks_) {
        while (oi < offsets.size() && offsets[oi] < lb.offset()) ++oi;
        breaks.push_back(oi);
    }

    // Build highlighting
    auto hl = std::make_unique<proto::HighlightingT>();
    hl->token_offsets = std::move(offsets);
    hl->token_types = std::move(types);
    hl->token_breaks = std::move(breaks);
    return hl;
}

}  // namespace parser
}  // namespace flatsql
