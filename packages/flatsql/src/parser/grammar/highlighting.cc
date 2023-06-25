#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"

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
        case Parser::symbol_kind_type::S_SCONST:
            return proto::HighlightingTokenType::LITERAL_STRING;
        case Parser::symbol_kind_type::S_ICONST:
            return proto::HighlightingTokenType::LITERAL_INTEGER;
        case Parser::symbol_kind_type::S_FCONST:
            return proto::HighlightingTokenType::LITERAL_FLOAT;
        case Parser::symbol_kind_type::S_BCONST:
            return proto::HighlightingTokenType::LITERAL_BINARY;
        case Parser::symbol_kind_type::S_XCONST:
            return proto::HighlightingTokenType::LITERAL_HEX;
        case Parser::symbol_kind_type::S_Op:
            return proto::HighlightingTokenType::OPERATOR;
        case Parser::symbol_kind_type::S_IDENT:
            return proto::HighlightingTokenType::IDENTIFIER;
        default:
            return proto::HighlightingTokenType::NONE;
    };
};
}  // namespace parser

/// Pack the FlatBuffer
std::unique_ptr<proto::HighlightingT> ScannedScript::PackHighlighting() {
    std::vector<uint32_t> offsets;
    std::vector<proto::HighlightingTokenType> types;
    offsets.reserve(symbols.GetSize() * 3 / 2);
    types.reserve(symbols.GetSize() * 3 / 2);

    // Emit highlighting tokens at a location.
    // We emit 2 tokens at the begin and the end of every location and overwrite types if the offsets equal.
    // That allows us to capture whitespace accurately for Monaco.
    auto emit = [](std::vector<uint32_t>& offsets, std::vector<proto::HighlightingTokenType>& types,
                   proto::Location loc, proto::HighlightingTokenType type) {
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
    symbols.ForEachIn(0, symbols.GetSize(), [&](size_t symbol_id, parser::Parser::symbol_type symbol) {
        // Emit all comments in between.
        while (ci < comments.size() && comments[ci].offset() < symbol.location.offset()) {
            emit(offsets, types, comments[ci++], proto::HighlightingTokenType::COMMENT);
        }
        // Map as standard token.
        emit(offsets, types, symbol.location, MapToken(symbol.kind()));
    });

    // Build the line breaks
    std::vector<uint32_t> breaks;
    breaks.reserve(line_breaks.size());
    auto oi = 0;
    for (auto& lb : line_breaks) {
        while (oi < offsets.size() && offsets[oi] < lb.offset()) ++oi;
        breaks.push_back(oi);
    }

    // Build highlighting
    auto hl = std::make_unique<proto::HighlightingT>();
    hl->token_offsets = offsets;
    hl->token_types = types;
    hl->token_breaks = breaks;
    return hl;
}

}  // namespace flatsql
