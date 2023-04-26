%start opt_statement_list;

opt_statement_list:
    statement_list
  | %empty

statement_list:
    statement_list ';' opt_statement  { ctx.AddStatement($3); }
  | statement error ';'               { yyclearin; yyerrok; }
  | statement                         { ctx.AddStatement($1); }
    ;

opt_statement:
    statement   { $$ = $1; }
  | %empty      { $$ = Null(); }

statement:
    sql_query_statement          { $$ = $1; }
    ;

sql_query_statement:
    sql_select_stmt     { $$ = ctx.Add(@$, proto::NodeType::OBJECT_SQL_SELECT, std::move($1)); }
  | sql_create_stmt     { $$ = std::move($1); }
  | sql_create_as_stmt  { $$ = std::move($1); }
  | sql_view_stmt       { $$ = std::move($1); }
  | set_statement       { $$ = std::move($1); }
    ;
