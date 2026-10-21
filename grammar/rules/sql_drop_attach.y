sql_drop_table_stmt:
    DROP TABLE sql_qualified_name { ctx.object(@$, NodeType::OBJECT_SQL_DROP_TABLE, &[attr(Key::SQL_DROP_NAME, $3)]) }
  | DROP TABLE IF_P EXISTS sql_qualified_name {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_DROP_TABLE,
          &[attr(Key::SQL_DROP_IF_EXISTS, bool_node(loc(&[@3, @4]), true)), attr(Key::SQL_DROP_NAME, $5)],
      )
  }
    ;

sql_drop_view_stmt:
    DROP VIEW sql_qualified_name { ctx.object(@$, NodeType::OBJECT_SQL_DROP_VIEW, &[attr(Key::SQL_DROP_NAME, $3)]) }
  | DROP VIEW IF_P EXISTS sql_qualified_name {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_DROP_VIEW,
          &[attr(Key::SQL_DROP_IF_EXISTS, bool_node(loc(&[@3, @4]), true)), attr(Key::SQL_DROP_NAME, $5)],
      )
  }
    ;

sql_attach_database_stmt:
    ATTACH sql_attach_database_locality DATABASE sql_attach_database_path AS sql_attach_database_alias sql_attach_database_options {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ATTACH_DATABASE,
            &[
                attr(Key::SQL_ATTACH_DATABASE_LOCAL, $2),
                attr(Key::SQL_ATTACH_DATABASE_PATH, $4),
                attr(Key::SQL_ATTACH_DATABASE_ALIAS, $6),
                attr(Key::SQL_ATTACH_DATABASE_OPTIONS, $7),
            ],
        )
    }
    ;

sql_attach_database_locality:
    LOCAL           { bool_node(@$, true) }
  | %empty          { null() }
    ;

sql_attach_database_path:
    sql_col_id       { $1 }
    ;

sql_attach_database_alias:
    sql_col_id       { $1 }
    ;

sql_attach_database_options:
    WITH LRB sql_attach_database_option_list RRB  { ctx.array(@$, $3) }
  | %empty                                      { null() }
    ;

sql_attach_database_option_list:
    sql_attach_database_option { ctx.list(&[$1]) }
  | sql_attach_database_option_list COMMA sql_attach_database_option {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_attach_database_option:
    sql_attach_database_value EQUALS sql_attach_database_value {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ATTACH_DATABASE_OPTION,
            &[attr(Key::SQL_GENERIC_OPTION_KEY, $1), attr(Key::SQL_GENERIC_OPTION_VALUE, $3)],
        )
    }
  | sql_attach_database_value EQUALS DEFAULT {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_ATTACH_DATABASE_OPTION,
          &[
              attr(Key::SQL_GENERIC_OPTION_KEY, $1),
              attr(Key::SQL_GENERIC_OPTION_VALUE, ctx.name_from_keyword(@3, "default")),
          ],
      )
  }
    ;

sql_attach_database_value:
    IDENT                       { name_from_identifier(@1, $1) }
  | sql_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
  | sql_column_name_keywords    { ctx.name_from_keyword(@1, $1) }
  | sql_type_func_keywords      { ctx.name_from_keyword(@1, $1) }
  | SCONST                      { const_node(@1, AConstType::STRING) }
    ;
