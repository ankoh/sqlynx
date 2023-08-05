#include "flatsql/parser/grammar/keywords.h"
#include "flatsql/proto/proto_generated.h"
#include "flatsql/script.h"

namespace flatsql {
namespace parser {
static const proto::ScannerTokenType MapToken(Parser::symbol_kind_type symbol) {
    switch (symbol) {
#define X(CATEGORY, NAME, TOKEN) case Parser::symbol_kind_type::S_##TOKEN:
#include "../../../grammar/lists/sql_column_name_keywords.list"
#include "../../../grammar/lists/sql_reserved_keywords.list"
#include "../../../grammar/lists/sql_type_func_keywords.list"
#include "../../../grammar/lists/sql_unreserved_keywords.list"
#undef X
        return proto::ScannerTokenType::KEYWORD;
        case Parser::symbol_kind_type::S_SCONST:
            return proto::ScannerTokenType::LITERAL_STRING;
        case Parser::symbol_kind_type::S_ICONST:
            return proto::ScannerTokenType::LITERAL_INTEGER;
        case Parser::symbol_kind_type::S_FCONST:
            return proto::ScannerTokenType::LITERAL_FLOAT;
        case Parser::symbol_kind_type::S_BCONST:
            return proto::ScannerTokenType::LITERAL_BINARY;
        case Parser::symbol_kind_type::S_XCONST:
            return proto::ScannerTokenType::LITERAL_HEX;
        case Parser::symbol_kind_type::S_Op:
            return proto::ScannerTokenType::OPERATOR;
        case Parser::symbol_kind_type::S_IDENT:
            return proto::ScannerTokenType::IDENTIFIER;
        default:
            return proto::ScannerTokenType::NONE;
    };
};
}  // namespace parser

/// Pack the highlighting data
std::unique_ptr<proto::ScannerTokensT> ScannedScript::PackTokens() {
    std::vector<uint32_t> offsets;
    std::vector<uint32_t> lengths;
    std::vector<proto::ScannerTokenType> types;
    offsets.reserve(symbols.GetSize() * 3 / 2);
    lengths.reserve(symbols.GetSize() * 3 / 2);
    types.reserve(symbols.GetSize() * 3 / 2);

    auto ci = 0;
    symbols.ForEachIn(0, symbols.GetSize() - 1, [&](size_t symbol_id, parser::Parser::symbol_type symbol) {
        // Emit all comments in between.
        while (ci < comments.size() && comments[ci].offset() < symbol.location.offset()) {
            auto& comment = comments[ci++];
            offsets.push_back(comment.offset());
            lengths.push_back(comment.length());
            types.push_back(proto::ScannerTokenType::COMMENT);
        }
        // Map as standard token.
        offsets.push_back(symbol.location.offset());
        lengths.push_back(symbol.location.length());
        types.push_back(MapToken(symbol.kind()));
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
    auto hl = std::make_unique<proto::ScannerTokensT>();
    hl->token_offsets = offsets;
    hl->token_lengths = lengths;
    hl->token_types = types;
    hl->token_breaks = breaks;
    return hl;
}

}  // namespace flatsql
