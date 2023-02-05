sql_view_stmt:
    CREATE_P sql_opt_temp VIEW sql_qualified_name sql_opt_column_list AS sql_select_stmt {
        $$ = ctx.Add(@$, proto::NodeType::OBJECT_SQL_VIEW, {
            Attr(Key::SQL_VIEW_TEMP, Enum(@2, $2)),
            Attr(Key::SQL_VIEW_NAME, std::move($4)),
            Attr(Key::SQL_VIEW_COLUMNS, ctx.Add(@5, std::move($5))),
            Attr(Key::SQL_VIEW_STATEMENT, ctx.Add(@7, proto::NodeType::OBJECT_SQL_SELECT, std::move($7))),
        });
    }
    ;
