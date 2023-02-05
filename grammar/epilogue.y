void flatsql::parser::Parser::error(const location_type& loc, const std::string& message) {
    ctx.AddError(loc, message);
}
