sql_insert_stmt:
    INSERT INTO sql_qualified_name sql_insert_rest sql_insert_returning_clause {
        let target = ctx.object(@3, NodeType::OBJECT_SQL_TABLEREF, &[attr(Key::SQL_TABLEREF_NAME, $3)]);
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_INSERT,
            ctx.concat2($4, &[attr(Key::SQL_INSERT_TARGET, target), attr(Key::SQL_INSERT_RETURNING, $5)]),
        )
    }
  | sql_with_clause INSERT INTO sql_qualified_name sql_insert_rest sql_insert_returning_clause {
      let target = ctx.object(@4, NodeType::OBJECT_SQL_TABLEREF, &[attr(Key::SQL_TABLEREF_NAME, $4)]);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INSERT,
          ctx.concat3($1, $5, &[attr(Key::SQL_INSERT_TARGET, target), attr(Key::SQL_INSERT_RETURNING, $6)]),
      )
  }
    ;

sql_insert_rest:
    sql_select_stmt { ctx.list(&[attr(Key::SQL_INSERT_SOURCE, ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1))]) }
  | LRB sql_name_list RRB sql_select_stmt {
      ctx.list(
          &[
              attr(Key::SQL_INSERT_COLUMNS, ctx.array(loc(&[@1, @2, @3]), $2)),
              attr(Key::SQL_INSERT_SOURCE, ctx.object(@4, NodeType::OBJECT_SQL_SELECT, $4)),
          ],
      )
  }
  | DEFAULT VALUES { ctx.list(&[attr(Key::SQL_INSERT_DEFAULT_VALUES, bool_node(@$, true))]) }
    ;

sql_insert_returning_clause:
    RETURNING sql_target_list { ctx.array(@2, $2) }
  | %empty                    { null() }
    ;
