sql_delete_stmt:
    sql_delete_body { ctx.object(@$, NodeType::OBJECT_SQL_DELETE, $1) }
  | sql_with_clause sql_delete_body { ctx.object(@$, NodeType::OBJECT_SQL_DELETE, ctx.concat2($1, $2)) }
    ;

sql_delete_body:
    DELETE_P FROM sql_delete_target sql_delete_using_clause sql_where_clause sql_insert_returning_clause {
        ctx.list(
            &[
                attr(Key::SQL_DELETE_TARGET, $3),
                attr(Key::SQL_DELETE_USING, $4),
                attr(Key::SQL_DELETE_WHERE, ctx.expression($5)),
                attr(Key::SQL_DELETE_RETURNING, $6),
            ],
        )
    }
    ;

sql_delete_target:
    sql_relation_expr sql_opt_alias_clause { ctx.object(@$, NodeType::OBJECT_SQL_TABLEREF, ctx.concat2($1, &[attr(Key::SQL_TABLEREF_ALIAS, $2)])) }
    ;

sql_delete_using_clause:
    USING sql_from_list { ctx.array(@2, $2) }
  | %empty             { null() }
    ;
