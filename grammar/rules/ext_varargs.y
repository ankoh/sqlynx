// ---------------------------------------------------------------------------
// FlatSQL Objects

vararg:
    '(' vararg_fields ')'  { $$ = ctx.Add(@$, proto::NodeType::OBJECT_EXT_VARARGS, std::move($2)); }
    ;

vararg_fields:
    vararg_fields ',' opt_vararg_field  { $1.push_back($3); $$ = std::move($1); }
  | opt_vararg_field                    { $$ = {$1}; }
    ;

opt_vararg_field:
    vararg_key_path '=' vararg_value { $$ = ctx.AddVarArgField(@$, std::move($1), $3); }
  | %empty                           { $$ = Null(); }
    ;

vararg_key_path:
    vararg_key_path '.' vararg_key  { $1.push_back(@3); $$ = std::move($1); }
  | vararg_key                      { $$ = { @1 }; }

vararg_key:
    SCONST
  | IDENT
  | sql_unreserved_keywords
  | sql_column_name_keywords
  | sql_type_func_keywords
  | sql_reserved_keywords
    ;

vararg_value:
    vararg                    { $$ = std::move($1); }
  | vararg_array_brackets     { $$ = ctx.Add(@$, std::move($1)); }
  | sql_columnref             { $$ = $1; }
  | sql_a_expr_const          { $$ = $1; }
  | '+' sql_a_expr_const %prec UMINUS   { $$ = $2; }
  | '-' sql_a_expr_const %prec UMINUS   { $$ = Negate(ctx, @$, @1, $2); }
    ;

vararg_array:
    vararg_array ',' vararg_value   { $1.push_back($3); $$ = std::move($1); }
  | vararg_value                    { $$ = {$1}; }
  | %empty                          { $$ = {}; }
    ;

vararg_array_brackets:
    '[' vararg_array ']'            { $$ = std::move($2); }
    ;
