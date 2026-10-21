sql_create_function_stmt:
    CREATE_P FUNCTION sql_qualified_name LRB sql_opt_function_param_list RRB RETURNS sql_function_param_type {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_CREATE_FUNCTION,
            &[
                attr(Key::SQL_CREATE_FUNCTION_NAME, $3),
                attr(Key::SQL_CREATE_FUNCTION_PARAMS, ctx.array(loc(&[@4, @5, @6]), $5)),
                attr(Key::SQL_CREATE_FUNCTION_RETURNS, $8),
            ],
        )
    }
  | CREATE_P AGGREGATE sql_qualified_name LRB sql_opt_function_param_list RRB RETURNS sql_function_param_type {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CREATE_FUNCTION,
          &[
              attr(Key::SQL_CREATE_FUNCTION_NAME, $3),
              attr(Key::SQL_CREATE_FUNCTION_PARAMS, ctx.array(loc(&[@4, @5, @6]), $5)),
              attr(Key::SQL_CREATE_FUNCTION_RETURNS, $8),
              attr(Key::SQL_CREATE_FUNCTION_IS_AGGREGATE, bool_node(@2, true)),
          ],
      )
  }
    ;

sql_opt_function_param_list:
    sql_function_param_list     { $1 }
  | %empty                      { ctx.list(NO_NODES) }
    ;

sql_function_param_list:
    sql_function_param                                  { ctx.list(&[$1]) }
  | sql_function_param_list COMMA sql_function_param    {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_function_param:
    sql_col_id sql_function_param_type {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_FUNCTION_PARAM,
            &[attr(Key::SQL_FUNCTION_PARAM_NAME, $1), attr(Key::SQL_FUNCTION_PARAM_TYPE, $2)],
        )
    }
    ;

sql_function_param_type:
    sql_typename    { $1 }
  | ANY {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPENAME,
          &[
              attr(
                  Key::SQL_TYPENAME_TYPE,
                  ctx.object(
                      @1,
                      NodeType::OBJECT_SQL_GENERIC_TYPE,
                      &[attr(Key::SQL_GENERIC_TYPE_NAME, ctx.name_from_keyword(@1, "any"))],
                  ),
              ),
          ],
      )
  }
    ;
