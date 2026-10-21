// ---------------------------------------------------------------------------
// DashQL Objects

varargs:
    LRB vararg_fields RRB  { $2 }
    ;

vararg_fields:
    vararg_fields COMMA opt_vararg_field  {
        ctx.push_back($1, $3);
        $1
    }
  | opt_vararg_field                    { ctx.list(&[$1]) }
    ;

opt_vararg_field:
    vararg_key_path EQUALS vararg_value { vararg_field(ctx, @$, $1, $3) }
  | %empty                           { null() }
    ;

vararg_key_path:
    vararg_key_path DOT vararg_key  {
        ctx.push_back($1, $3);
        $1
    }
  | vararg_key                      { ctx.list(&[$1]) }

vararg_key:
    SCONST                      { const_node(@1, AConstType::STRING) }
  | IDENT                       { name_from_identifier(@1, $1) }
  | sql_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
  | sql_column_name_keywords    { ctx.name_from_keyword(@1, $1) }
  | sql_type_func_keywords      { ctx.name_from_keyword(@1, $1) }
  | sql_reserved_keywords       { ctx.name_from_keyword(@1, $1) }
  | vis_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
    ;

vararg_value:
    varargs                   { ctx.array(@$, $1) }
  | vararg_array_brackets { ctx.object(@$, NodeType::OBJECT_EXT_VARARG_ARRAY, &[attr(Key::EXT_VARARG_ARRAY_VALUES, ctx.array_ex(@1, $1, false, false))]) }
  | sql_func_expr             { $1 }
  | sql_columnref             { $1 }
  | sql_a_expr_const          { ctx.expression($1) }
  | PLUS sql_a_expr_const %prec UMINUS   { ctx.expression($2) }
  | MINUS sql_a_expr_const %prec UMINUS   { negate(ctx, @$, @1, ctx.expression($2)) }
    ;

vararg_array:
    vararg_array COMMA vararg_value   {
        ctx.push_back($1, $3);
        $1
    }
  | vararg_value                    { ctx.list(&[$1]) }
  | %empty                          { ctx.list(NO_NODES) }
    ;

vararg_array_brackets:
    LSB vararg_array RSB            { $2 }
    ;
