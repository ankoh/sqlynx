#include "flatsql/parser/parse_context.h"
#include "flatsql/parser/parser.h"

void flatsql::parser::ParserBase::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message);
}
