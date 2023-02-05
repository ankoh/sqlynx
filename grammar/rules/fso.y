// ---------------------------------------------------------------------------
// FlatSQL Objects

opt_fso:
    fso       { $$ = std::move($1); }
  | %empty     { $$ = {}; }
    ;

fso:
    '(' fso_fields ')'  { $$ = ctx.Add(@$, proto::NodeType::OBJECT_FSO, std::move($2)); }
    ;

fso_fields:
    fso_fields ',' opt_fso_field  { $1.push_back($3); $$ = std::move($1); }
  | opt_fso_field                  { $$ = {$1}; }
    ;

opt_fso_field:
    fso_key_path '=' fso_value    { $$ = ctx.AddFSOField(@$, std::move($1), $3); }
  | %empty                          { $$ = Null(); }
    ;

fso_key_path:
    fso_key_path '.' fso_key  { $1.push_back(@3); $$ = std::move($1); }
  | fso_key                    { $$ = { @1 }; }

fso_key:
    SCONST
  | IDENT
  | sql_unreserved_keywords
  | sql_column_name_keywords
  | sql_type_func_keywords
  | sql_reserved_keywords
    ;

fso_value:
    fso                      { $$ = std::move($1); }
  | fso_array_brackets       { $$ = ctx.Add(@$, std::move($1)); }
  | sql_columnref             { $$ = $1; }
  | sql_a_expr_const          { $$ = $1; }
  | '+' sql_a_expr_const %prec UMINUS   { $$ = $2; }
  | '-' sql_a_expr_const %prec UMINUS   { $$ = Negate(ctx, @$, @1, $2); }
    ;

fso_array:
    fso_array ',' fso_value     { $1.push_back($3); $$ = move($1); }
  | fso_value                    { $$ = {$1}; }
  | %empty                        { $$ = {}; }
    ;

fso_array_brackets:
    '[' fso_array ']'            { $$ = move($2); }
    ;
