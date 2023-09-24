#include "flatsql/parser/parser.h"

#include "flatsql/parser/parse_context.h"

namespace flatsql::parser {

void flatsql::parser::ParserBase::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message);
}

std::pair<std::shared_ptr<ParsedScript>, proto::StatusCode> Parser::Parse(std::shared_ptr<ScannedScript> scanned,
                                                                          bool trace_scanning, bool trace_parsing) {
    if (scanned == nullptr) {
        return {nullptr, proto::StatusCode::PARSER_INPUT_INVALID};
    }

    // Parse the tokens
    ParseContext ctx{*scanned};
    flatsql::parser::Parser parser(ctx);
    parser.parse();

    // Make sure we didn't leak into our temp allocators.
    // This can happen quickly when not consuming an allocated list in a bison rule.
#define DEBUG_BISON_LEAKS 0
#if DEBUG_BISON_LEAKS
    auto text = in.ToString();
    auto text_view = std::string_view{text};
    ctx.temp_list_elements.ForEachAllocated([&](size_t value_id, NodeList::ListElement& elem) {
        std::cout << proto::EnumNameAttributeKey(static_cast<proto::AttributeKey>(elem.node.attribute_key())) << " "
                  << proto::EnumNameNodeType(elem.node.node_type()) << " "
                  << text_view.substr(elem.node.location().offset(), elem.node.location().length()) << std::endl;
    });
#else
    if (ctx.errors.empty()) {
        assert(ctx.temp_list_elements.GetAllocatedNodeCount() == 0);
    }
#endif

    assert(ctx.temp_nary_expressions.GetAllocatedNodeCount() == 0);

    // Pack the program
    return {std::make_shared<ParsedScript>(scanned, std::move(ctx)), proto::StatusCode::OK};
}

}  // namespace flatsql::parser
