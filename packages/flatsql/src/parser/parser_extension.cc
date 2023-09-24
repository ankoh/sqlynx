#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/parser_generated.h"

void flatsql::parser::Parser::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message);
}
