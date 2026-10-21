sql_view_stmt:
    CREATE_P sql_opt_temp VIEW sql_qualified_name sql_opt_column_list AS sql_select_stmt {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_VIEW,
            &[
                attr(Key::SQL_VIEW_TEMP, $2),
                attr(Key::SQL_VIEW_NAME, $4),
                attr(Key::SQL_VIEW_COLUMNS, ctx.array(@5, $5)),
                attr(Key::SQL_VIEW_STATEMENT, ctx.object(@7, NodeType::OBJECT_SQL_SELECT, $7)),
            ],
        )
    }
  | CREATE_P OR REPLACE sql_opt_temp VIEW sql_qualified_name sql_opt_column_list AS sql_select_stmt {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_VIEW,
          &[
              attr(Key::SQL_VIEW_OR_REPLACE, bool_node(loc(&[@2, @3]), true)),
              attr(Key::SQL_VIEW_TEMP, $4),
              attr(Key::SQL_VIEW_NAME, $6),
              attr(Key::SQL_VIEW_COLUMNS, ctx.array(@7, $7)),
              attr(Key::SQL_VIEW_STATEMENT, ctx.object(@9, NodeType::OBJECT_SQL_SELECT, $9)),
          ],
      )
  }
    ;
