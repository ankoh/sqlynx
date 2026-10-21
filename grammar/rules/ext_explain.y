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
    EXPLAIN explainable_stmt { ctx.object(@$, NodeType::OBJECT_EXT_EXPLAIN, &[attr(Key::EXT_EXPLAIN_STATEMENT, $2)]) }
  | EXPLAIN LRB explain_option_list RRB explainable_stmt {
      ctx.object(
          @$,
          NodeType::OBJECT_EXT_EXPLAIN,
          &[
              attr(Key::EXT_EXPLAIN_STATEMENT, $5),
              attr(Key::EXT_EXPLAIN_OPTIONS, ctx.array(loc(&[@2, @3, @4]), $3)),
          ],
      )
  }
    ;

explainable_stmt:
    sql_select_stmt     { ctx.object(@$, NodeType::OBJECT_SQL_SELECT, $1) }
  | sql_create_stmt     { $1 }
  | sql_create_as_stmt  { $1 }
  | sql_view_stmt       { $1 }
  | sql_insert_stmt     { $1 }
  | sql_delete_stmt     { $1 }
  | EXPRESSIONS LRB sql_expr_list RRB {
      ctx.object(@$, NodeType::OBJECT_EXT_EXPLAIN_EXPRESSIONS, &[attr(Key::EXT_EXPLAIN_EXPRESSIONS, ctx.array(@3, $3))])
  }
    ;

explain_option_list:
    explain_option_elem                                     { ctx.list(&[$1]) }
  | explain_option_list COMMA explain_option_elem           {
      ctx.push_back($1, $3);
      $1
  }
    ;

explain_option_elem:
    explain_option_name explain_option_arg {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GENERIC_OPTION,
            &[attr(Key::SQL_GENERIC_OPTION_KEY, $1), attr(Key::SQL_GENERIC_OPTION_VALUE, $2)],
        )
    }
    ;

explain_option_name:
    sql_col_id                  { $1 }
  | sql_type_func_keywords      { ctx.name_from_keyword(@1, $1) }
  | ANALYZE                     { ctx.name_from_keyword(@1, $1) }
  | ANALYSE                     { ctx.name_from_keyword(@1, $1) }
    ;

explain_option_arg:
    TRUE_P                      { bool_node(@1, true) }
  | FALSE_P                     { bool_node(@1, false) }
  | ON                          { bool_node(@1, true) }
  | LRB sql_name_list RRB       { ctx.array(@$, $2) }
  | sql_descriptor_arg          { $1 }
  | sql_col_id                  { $1 }
  | sql_type_func_keywords      { ctx.name_from_keyword(@1, $1) }
  | ICONST                      { const_node(@1, AConstType::INTEGER) }
  | FCONST                      { const_node(@1, AConstType::FLOAT) }
  | SCONST                      { const_node(@1, AConstType::STRING) }
  | %empty                      { null() }
    ;
