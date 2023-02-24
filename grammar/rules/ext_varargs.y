// ---------------------------------------------------------------------------
// FlatSQL Objects

vararg:
    '(' vararg_fields ')'  { $$ = std::move($2); }
    ;

vararg_fields:
    vararg_fields ',' opt_vararg_field  { $1.push_back($3); $$ = std::move($1); }
  | opt_vararg_field                    { $$ = {$1}; }
    ;

opt_vararg_field:
    vararg_key_path '=' vararg_value { $$ = VarArgField(ctx, @$, std::move($1), $3); }
  | %empty                           { $$ = Null(); }
    ;

vararg_key_path:
    vararg_key_path '.' vararg_key  { $1.push_back($3); $$ = std::move($1); }
  | vararg_key                      { $$ = { $1 }; }

vararg_key:
    SCONST                      { $$ = Const(@1, proto::AConstType::STRING); }
  | IDENT                       { $$ = Ident(@1); }
  | sql_unreserved_keywords     { $$ = Ident(@1); }
  | sql_column_name_keywords    { $$ = Ident(@1); }
  | sql_type_func_keywords      { $$ = Ident(@1); }
  | sql_reserved_keywords       { $$ = Ident(@1); }
    ;

vararg_value:
    vararg                    { $$ = ctx.Add(@$, std::move($1)); }
  | vararg_array_brackets     { $$ = ctx.Add(@$, std::move($1)); }
  | sql_func_expr             { $$ = $1; }
  | sql_columnref             { $$ = $1; }
  | sql_a_expr_const          { $$ = ctx.Add(std::move($1)); }
  | '+' sql_a_expr_const %prec UMINUS   { $$ = ctx.Add(std::move($2)); }
  | '-' sql_a_expr_const %prec UMINUS   { $$ = Negate(ctx, @$, @1, ctx.Add(std::move($2))); }
    ;

vararg_array:
    vararg_array ',' vararg_value   { $1.push_back($3); $$ = std::move($1); }
  | vararg_value                    { $$ = {$1}; }
  | %empty                          { $$ = {}; }
    ;

vararg_array_brackets:
    '[' vararg_array ']'            { $$ = std::move($2); }
    ;
