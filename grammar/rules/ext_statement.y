%start opt_statement_list;

opt_statement_list:
    statement_list
  | %empty

statement_list:
    statement_list SEMICOLON opt_statement  { ctx.add_statement($3); }
  | error                             {
      ctx.reset_statement();
      ctx.clear_lookahead();
  }
  | statement                         { ctx.add_statement($1); }
    ;

opt_statement:
    statement   { $1 }
  | error       {
      ctx.clear_lookahead();
      null()
  }
  | %empty      { null() }

statement:
    sql_query_statement          { $1 }
    ;

sql_query_statement:
    sql_select_stmt       { ctx.object(@$, NodeType::OBJECT_SQL_SELECT, $1) }
  | sql_create_stmt       { $1 }
  | sql_create_as_stmt    { $1 }
  | sql_view_stmt         { $1 }
  | set_statement         { $1 }
  | vis_visualise_stmt    { $1 }
  | sql_create_function_stmt  { $1 }
  | explain_stmt              { $1 }
  | sql_drop_table_stmt       { $1 }
  | sql_drop_view_stmt        { $1 }
  | sql_attach_database_stmt  { $1 }
  | sql_insert_stmt           { $1 }
  | sql_delete_stmt           { $1 }
    ;
