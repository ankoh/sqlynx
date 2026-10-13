/*
    Hyper options:

    explain (optimize steps, costs)
    explain (format text_tree)
    explain (format analyze)
    explain (format sql_stages)
    explain (format referenced_tables)
    explain (format json)
    explain (format internal_json)
    explain (format terse_internal_json)
    explain (format schema)
    explain (format schema, with_lineage)
    explain (format schema, preaggregation)
    explain (format schema, postaggregation, sql_dialect hyper)
    explain (format sql, sql_dialect internal_spark)
    explain (format sql, sql_dialect amazon_redshift)
    explain (format sql, sql_dialect apache_calcite)
    explain (format sql, sql_dialect azure_synapse)
    explain (format sql, sql_dialect cdata)
    explain (format sql, sql_dialect cdata_scan_only)
    explain (format sql, sql_dialect databricks)
    explain (format sql, sql_dialect google_bigquery)
    explain (format sql, sql_dialect hyper)
    explain (format sql, sql_dialect mariadb_10)
    explain (format sql, sql_dialect microsoft_sql_server_2016)
    explain (format sql, sql_dialect mysql_8)
    explain (format sql, sql_dialect oracle_19)
    explain (format sql, sql_dialect postgresql_12)
    explain (format sql, sql_dialect postgresql_15)
    explain (format sql, sql_dialect snowflake)
    explain (format sql, sql_dialect trino)
*/

explain_stmt:
    EXPLAIN explainable_stmt {
        $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_EXT_EXPLAIN, {
            Attr(Key::EXT_EXPLAIN_STATEMENT, $2),
        });
    }
  | EXPLAIN LRB explain_option_list RRB explainable_stmt {
        $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_EXT_EXPLAIN, {
            Attr(Key::EXT_EXPLAIN_STATEMENT, $5),
            Attr(Key::EXT_EXPLAIN_OPTIONS, ctx.Array(Loc({@2, @3, @4}), std::move($3))),
        });
    }
    ;

explainable_stmt:
    sql_select_stmt     { $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_SQL_SELECT, std::move($1)); }
  | sql_create_stmt     { $$ = std::move($1); }
  | sql_create_as_stmt  { $$ = std::move($1); }
  | sql_view_stmt       { $$ = std::move($1); }
  | sql_insert_stmt     { $$ = std::move($1); }
  | sql_delete_stmt     { $$ = std::move($1); }
  | EXPRESSIONS LRB sql_expr_list RRB {
        $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_EXT_EXPLAIN_EXPRESSIONS, {
            Attr(Key::EXT_EXPLAIN_EXPRESSIONS, ctx.Array(@3, std::move($3))),
        });
    }
    ;

explain_option_list:
    explain_option_elem                                     { $$ = ctx.List({ std::move($1) }); }
  | explain_option_list COMMA explain_option_elem           { $1->push_back(std::move($3)); $$ = std::move($1); }
    ;

explain_option_elem:
    explain_option_name explain_option_arg {
        $$ = ctx.Object(@$, buffers::parser::NodeType::OBJECT_SQL_GENERIC_OPTION, {
            Attr(Key::SQL_GENERIC_OPTION_KEY, $1),
            Attr(Key::SQL_GENERIC_OPTION_VALUE, $2),
        });
    }
    ;

explain_option_name:
    sql_col_id                  { $$ = std::move($1); }
  | sql_type_func_keywords      { $$ = ctx.NameFromKeyword(@1, $1); }
  | ANALYZE                     { $$ = ctx.NameFromKeyword(@1, $1); }
  | ANALYSE                     { $$ = ctx.NameFromKeyword(@1, $1); }
    ;

explain_option_arg:
    TRUE_P                      { $$ = Bool(@1, true); }
  | FALSE_P                     { $$ = Bool(@1, false); }
  | ON                          { $$ = Bool(@1, true); }
  | LRB sql_name_list RRB       { $$ = ctx.Array(@$, std::move($2)); }
  | sql_descriptor_arg          { $$ = std::move($1); }
  | sql_col_id                  { $$ = std::move($1); }
  | sql_type_func_keywords      { $$ = ctx.NameFromKeyword(@1, $1); }
  | ICONST                      { $$ = Const(@1, buffers::parser::AConstType::INTEGER); }
  | FCONST                      { $$ = Const(@1, buffers::parser::AConstType::FLOAT); }
  | SCONST                      { $$ = Const(@1, buffers::parser::AConstType::STRING); }
  | %empty                      { $$ = Null(); }
    ;
