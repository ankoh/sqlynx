sql_delete_stmt:
    sql_delete_body { $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_SQL_DELETE, std::move($1)); }
  | sql_with_clause sql_delete_body {
        $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_SQL_DELETE,
                        Concat(std::move($1), std::move($2)));
    }
    ;

sql_delete_body:
    DELETE_P FROM sql_delete_target sql_delete_using_clause sql_where_clause sql_insert_returning_clause {
        $$ = ctx.List({
            Attr(Key::SQL_DELETE_TARGET, std::move($3)),
            Attr(Key::SQL_DELETE_USING, std::move($4)),
            Attr(Key::SQL_DELETE_WHERE, ctx.Expression(std::move($5))),
            Attr(Key::SQL_DELETE_RETURNING, std::move($6)),
        });
    }
    ;

sql_delete_target:
    sql_relation_expr sql_opt_alias_clause {
        $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_SQL_TABLEREF,
                        Concat(std::move($1), {Attr(Key::SQL_TABLEREF_ALIAS, std::move($2))}));
    }
    ;

sql_delete_using_clause:
    USING sql_from_list { $$ = ctx.Array(@2, std::move($2)); }
  | %empty             { $$ = Null(); }
    ;
