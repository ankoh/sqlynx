// SQL/PGQ property graph definitions and GRAPH_TABLE queries.

sql_common_element_expr:
    sql_common_table_expr { $1 }
  | sql_name AS SECURE LRB sql_select_stmt RRB {
      let select = ctx.object(@5, NodeType::OBJECT_SQL_SELECT, $5);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CTE,
          &[
              attr(Key::SQL_CTE_NAME, $1),
              attr(Key::SQL_CTE_STATEMENT, select),
              attr(Key::SQL_CTE_SECURE, bool_node(@3, true)),
          ],
      )
  }
  | sql_name LRB sql_name_list RRB AS SECURE LRB sql_select_stmt RRB {
      let select = ctx.object(@8, NodeType::OBJECT_SQL_SELECT, $8);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CTE,
          &[
              attr(Key::SQL_CTE_NAME, $1),
              attr(Key::SQL_CTE_COLUMNS, ctx.array(@3, $3)),
              attr(Key::SQL_CTE_STATEMENT, select),
              attr(Key::SQL_CTE_SECURE, bool_node(@6, true)),
          ],
      )
  }
  | sql_name AS PROPERTY GRAPH LRB sql_property_graph_definition RRB {
      let graph = ctx.object_ex(@$, NodeType::OBJECT_SQL_PROPERTY_GRAPH, $6, false, false);
      ctx.object(@$, NodeType::OBJECT_SQL_CTE, &[attr(Key::SQL_CTE_NAME, $1), attr(Key::SQL_CTE_PROPERTY_GRAPH, graph)])
  }
    ;

sql_property_graph_definition:
    sql_opt_graph_vertex_tables_clause sql_opt_graph_edge_tables_clause {
        ctx.list(
            &[
                attr(Key::SQL_PROPERTY_GRAPH_VERTEX_TABLES, ctx.array(@1, $1)),
                attr(Key::SQL_PROPERTY_GRAPH_EDGE_TABLES, ctx.array(@2, $2)),
            ],
        )
    }
    ;

sql_opt_graph_vertex_tables_clause:
    NODE TABLES LRB sql_graph_vertex_table_list RRB   { $4 }
  | VERTEX TABLES LRB sql_graph_vertex_table_list RRB { $4 }
  | %empty                                             { ctx.list(NO_NODES) }
    ;

sql_graph_vertex_table_list:
    sql_graph_vertex_table_definition { ctx.list(&[$1]) }
  | sql_graph_vertex_table_list COMMA sql_graph_vertex_table_definition {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_graph_vertex_table_definition:
    sql_qualified_name sql_opt_graph_element_table_alias sql_opt_graph_element_table_key_clause
        sql_graph_element_table_label_and_properties {
            let table = ctx.object(
                @1,
                NodeType::OBJECT_SQL_TABLEREF,
                &[attr(Key::SQL_TABLEREF_NAME, $1), attr(Key::SQL_TABLEREF_ALIAS, $2)],
            );
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_ELEMENT_TABLE,
                &[
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_TABLE, table),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_KEY, $3),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_LABELS, $4),
                ],
            )
        }
  | sql_select_with_parens AS sql_name sql_opt_graph_element_table_key_clause
        sql_graph_element_table_label_and_properties {
            let select = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
            let alias = ctx.object(@3, NodeType::OBJECT_SQL_ALIAS, &[attr(Key::SQL_ALIAS_NAME, $3)]);
            let table = ctx.object(
                loc(&[@1, @2, @3]),
                NodeType::OBJECT_SQL_TABLEREF,
                &[attr(Key::SQL_TABLEREF_TABLE, select), attr(Key::SQL_TABLEREF_ALIAS, alias)],
            );
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_ELEMENT_TABLE,
                &[
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_TABLE, table),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_KEY, $4),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_LABELS, $5),
                ],
            )
        }
    ;

sql_opt_graph_element_table_key_clause:
    KEY LRB sql_column_list RRB { ctx.array(@$, $3) }
  | %empty                      { null() }
    ;

sql_opt_graph_element_table_alias:
    AS sql_name { ctx.object(@$, NodeType::OBJECT_SQL_ALIAS, &[attr(Key::SQL_ALIAS_NAME, $2)]) }
  | %empty { null() }
    ;

sql_opt_graph_edge_tables_clause:
    EDGE TABLES LRB sql_graph_edge_table_list RRB         { $4 }
  | RELATIONSHIP TABLES LRB sql_graph_edge_table_list RRB { $4 }
  | %empty                                                   { ctx.list(NO_NODES) }
    ;

sql_graph_edge_table_list:
    sql_graph_edge_table_definition { ctx.list(&[$1]) }
  | sql_graph_edge_table_list COMMA sql_graph_edge_table_definition {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_graph_edge_table_definition:
    sql_qualified_name sql_opt_graph_element_table_alias sql_opt_graph_element_table_key_clause
        sql_graph_source_vertex_table sql_graph_destination_vertex_table
        sql_graph_element_table_label_and_properties {
            let table = ctx.object(
                @1,
                NodeType::OBJECT_SQL_TABLEREF,
                &[attr(Key::SQL_TABLEREF_NAME, $1), attr(Key::SQL_TABLEREF_ALIAS, $2)],
            );
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_ELEMENT_TABLE,
                &[
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_TABLE, table),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_KEY, $3),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_SOURCE, $4),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_DESTINATION, $5),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_LABELS, $6),
                ],
            )
        }
  | sql_select_with_parens AS sql_name sql_opt_graph_element_table_key_clause
        sql_graph_source_vertex_table sql_graph_destination_vertex_table
        sql_graph_element_table_label_and_properties {
            let select = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
            let alias = ctx.object(@3, NodeType::OBJECT_SQL_ALIAS, &[attr(Key::SQL_ALIAS_NAME, $3)]);
            let table = ctx.object(
                loc(&[@1, @2, @3]),
                NodeType::OBJECT_SQL_TABLEREF,
                &[attr(Key::SQL_TABLEREF_TABLE, select), attr(Key::SQL_TABLEREF_ALIAS, alias)],
            );
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_ELEMENT_TABLE,
                &[
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_TABLE, table),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_KEY, $4),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_SOURCE, $5),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_DESTINATION, $6),
                    attr(Key::SQL_GRAPH_ELEMENT_TABLE_LABELS, $7),
                ],
            )
        }
    ;

sql_graph_source_vertex_table:
    SOURCE sql_name {
        ctx.object(@$, NodeType::OBJECT_SQL_GRAPH_VERTEX_REFERENCE, &[attr(Key::SQL_GRAPH_VERTEX_REFERENCE_NAME, $2)])
    }
  | SOURCE KEY LRB sql_column_list RRB REFERENCES sql_name sql_opt_column_list {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_VERTEX_REFERENCE,
          &[
              attr(Key::SQL_GRAPH_VERTEX_REFERENCE_NAME, $7),
              attr(Key::SQL_GRAPH_VERTEX_REFERENCE_KEY, ctx.array(@4, $4)),
              attr(Key::SQL_GRAPH_VERTEX_REFERENCE_COLUMNS, ctx.array(@8, $8)),
          ],
      )
  }
    ;

sql_graph_destination_vertex_table:
    DESTINATION sql_name {
        ctx.object(@$, NodeType::OBJECT_SQL_GRAPH_VERTEX_REFERENCE, &[attr(Key::SQL_GRAPH_VERTEX_REFERENCE_NAME, $2)])
    }
  | DESTINATION KEY LRB sql_column_list RRB REFERENCES sql_name sql_opt_column_list {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_VERTEX_REFERENCE,
          &[
              attr(Key::SQL_GRAPH_VERTEX_REFERENCE_NAME, $7),
              attr(Key::SQL_GRAPH_VERTEX_REFERENCE_KEY, ctx.array(@4, $4)),
              attr(Key::SQL_GRAPH_VERTEX_REFERENCE_COLUMNS, ctx.array(@8, $8)),
          ],
      )
  }
    ;

sql_graph_element_table_label_and_properties:
    sql_graph_element_table_properties {
        let label = ctx.object(
            @1,
            NodeType::OBJECT_SQL_GRAPH_LABEL,
            &[
                attr(Key::SQL_GRAPH_LABEL_DEFAULT, bool_node(@1, true)),
                attr(Key::SQL_GRAPH_LABEL_PROPERTIES, $1),
            ],
        );
        ctx.array(@$, &[label])
    }
  | sql_graph_label_and_properties_list { ctx.array(@$, $1) }
  | %empty {
      let properties = ctx.object(@$, NodeType::OBJECT_SQL_GRAPH_PROPERTIES, &[attr(Key::SQL_GRAPH_PROPERTIES_ALL, bool_node(@$, true))]);
      let label = ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL,
          &[
              attr(Key::SQL_GRAPH_LABEL_DEFAULT, bool_node(@$, true)),
              attr(Key::SQL_GRAPH_LABEL_PROPERTIES, properties),
          ],
      );
      ctx.array(@$, &[label])
  }
    ;

sql_graph_label_and_properties_list:
    sql_graph_label_and_properties { ctx.list(&[$1]) }
  | sql_graph_label_and_properties_list sql_graph_label_and_properties {
      ctx.push_back($1, $2);
      $1
  }
    ;

sql_graph_label_and_properties:
    LABEL sql_name {
        let properties = ctx.object(
            @$,
            NodeType::OBJECT_SQL_GRAPH_PROPERTIES,
            &[attr(Key::SQL_GRAPH_PROPERTIES_ALL, bool_node(@$, true))],
        );
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GRAPH_LABEL,
            &[attr(Key::SQL_GRAPH_LABEL_NAME, $2), attr(Key::SQL_GRAPH_LABEL_PROPERTIES, properties)],
        )
    }
  | LABEL sql_name sql_graph_element_table_properties {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL,
          &[attr(Key::SQL_GRAPH_LABEL_NAME, $2), attr(Key::SQL_GRAPH_LABEL_PROPERTIES, $3)],
      )
  }
  | DEFAULT LABEL {
      let properties = ctx.object(@$, NodeType::OBJECT_SQL_GRAPH_PROPERTIES, &[attr(Key::SQL_GRAPH_PROPERTIES_ALL, bool_node(@$, true))]);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL,
          &[
              attr(Key::SQL_GRAPH_LABEL_DEFAULT, bool_node(@1, true)),
              attr(Key::SQL_GRAPH_LABEL_PROPERTIES, properties),
          ],
      )
  }
  | DEFAULT LABEL sql_graph_element_table_properties {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL,
          &[attr(Key::SQL_GRAPH_LABEL_DEFAULT, bool_node(@1, true)), attr(Key::SQL_GRAPH_LABEL_PROPERTIES, $3)],
      )
  }
    ;

sql_graph_element_table_properties:
    NO PROPERTIES { ctx.object_ex(@$, NodeType::OBJECT_SQL_GRAPH_PROPERTIES, NO_NODES, false, false) }
  | PROPERTIES sql_opt_are ALL COLUMNS sql_opt_graph_except_clause {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_PROPERTIES,
          &[
              attr(Key::SQL_GRAPH_PROPERTIES_ALL, bool_node(@3, true)),
              attr(Key::SQL_GRAPH_PROPERTIES_EXCLUDE, $5),
          ],
      )
  }
  | PROPERTIES LRB sql_graph_property_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_PROPERTIES,
          &[attr(Key::SQL_GRAPH_PROPERTIES_COLUMNS, ctx.array(@3, $3))],
      )
  }
    ;

sql_opt_are:
    ARE
  | %empty
    ;

sql_opt_graph_except_clause:
    EXCEPT LRB sql_column_list RRB { ctx.array(@$, $3) }
  | %empty                         { null() }
    ;

sql_graph_property_list:
    sql_graph_property { ctx.list(&[$1]) }
  | sql_graph_property_list COMMA sql_graph_property {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_graph_property:
    sql_name {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GRAPH_PROPERTY,
            &[attr(Key::SQL_GRAPH_PROPERTY_VALUE, column_ref(ctx, @1, ctx.list(&[$1])))],
        )
    }
  | sql_a_expr AS sql_col_id {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_PROPERTY,
          &[attr(Key::SQL_GRAPH_PROPERTY_VALUE, ctx.expression($1)), attr(Key::SQL_GRAPH_PROPERTY_NAME, $3)],
      )
  }
    ;

sql_graph_table_ref:
    GRAPH_TABLE LRB sql_qualified_name MATCH sql_graph_match
        sql_opt_graph_table_rows_clause sql_opt_graph_columns_clause RRB {
            let graph = ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_TABLE,
                &[
                    attr(Key::SQL_GRAPH_TABLE_GRAPH, $3),
                    attr(Key::SQL_GRAPH_TABLE_MATCH, $5),
                    attr(Key::SQL_GRAPH_TABLE_ROWS, $6),
                    attr(Key::SQL_GRAPH_TABLE_COLUMNS, $7),
                ],
            );
            graph
        }
    ;

sql_graph_match:
    sql_graph_path_pattern_list sql_graph_where_clause {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GRAPH_MATCH,
            &[attr(Key::SQL_GRAPH_MATCH_PATTERNS, ctx.array(@1, $1)), attr(Key::SQL_GRAPH_MATCH_WHERE, $2)],
        )
    }
    ;

sql_graph_where_clause:
    WHERE sql_a_expr { ctx.expression($2) }
  | %empty           { null() }
    ;

sql_graph_path_pattern_list:
    sql_graph_path_pattern { ctx.list(&[ctx.array(@1, $1)]) }
  | sql_graph_path_pattern_list COMMA sql_graph_path_pattern {
      ctx.push_back($1, ctx.array(@3, $3));
      $1
  }
    ;

sql_graph_path_pattern:
    sql_graph_path_term { $1 }
    ;

sql_graph_path_term:
    sql_graph_path_factor { ctx.list(&[$1]) }
  | sql_graph_path_term sql_graph_path_factor {
      ctx.push_back($1, $2);
      $1
  }
    ;

sql_graph_path_factor:
    sql_graph_path_primary { $1 }
    ;

sql_graph_path_primary:
    LRB sql_opt_col_id sql_opt_graph_label_expression sql_where_clause RRB {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GRAPH_PATH_ELEMENT,
            &[
                attr(Key::SQL_GRAPH_PATH_ELEMENT_VERTEX, bool_node(@1, true)),
                attr(Key::SQL_GRAPH_PATH_ELEMENT_VARIABLE, $2),
                attr(Key::SQL_GRAPH_PATH_ELEMENT_LABEL, $3),
                attr(Key::SQL_GRAPH_PATH_ELEMENT_WHERE, $4),
            ],
        )
    }
  | LESS_THAN MINUS LSB sql_opt_col_id sql_opt_graph_label_expression sql_where_clause RSB MINUS
        sql_opt_graph_pattern_quantifier {
            ctx.require_adjacent(@1, @2, "<-");
            ctx.require_adjacent(@2, @3, "-[");
            ctx.require_adjacent(@7, @8, "]-");
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_PATH_ELEMENT,
                &[
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_EDGE_LEFT, bool_node(loc(&[@1, @2]), true)),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_VARIABLE, $4),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_LABEL, $5),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_WHERE, $6),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_QUANTIFIER, $9),
                ],
            )
        }
  | MINUS LSB sql_opt_col_id sql_opt_graph_label_expression sql_where_clause RSB Op
        sql_opt_graph_pattern_quantifier {
            ctx.require_adjacent(@1, @2, "-[");
            ctx.require_adjacent(@6, @7, "]->");
            ctx.require_operator(@7, "->");
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_PATH_ELEMENT,
                &[
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_EDGE_RIGHT, bool_node(@7, true)),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_VARIABLE, $3),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_LABEL, $4),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_WHERE, $5),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_QUANTIFIER, $8),
                ],
            )
        }
  | MINUS LSB sql_opt_col_id sql_opt_graph_label_expression sql_where_clause RSB MINUS
        sql_opt_graph_pattern_quantifier {
            ctx.require_adjacent(@1, @2, "-[");
            ctx.require_adjacent(@6, @7, "]-");
            ctx.object(
                @$,
                NodeType::OBJECT_SQL_GRAPH_PATH_ELEMENT,
                &[
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_EDGE_ANY, bool_node(@7, true)),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_VARIABLE, $3),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_LABEL, $4),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_WHERE, $5),
                    attr(Key::SQL_GRAPH_PATH_ELEMENT_QUANTIFIER, $8),
                ],
            )
        }
    ;

sql_opt_graph_pattern_quantifier:
    sql_graph_pattern_quantifier { $1 }
  | %empty                       { null() }
    ;

sql_graph_pattern_quantifier:
    LCB ICONST RCB {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GRAPH_QUANTIFIER,
            &[
                attr(Key::SQL_GRAPH_QUANTIFIER_LOWER, const_node(@2, AConstType::INTEGER)),
                attr(Key::SQL_GRAPH_QUANTIFIER_UPPER, const_node(@2, AConstType::INTEGER)),
                attr(Key::SQL_GRAPH_QUANTIFIER_FIXED, bool_node(@2, true)),
            ],
        )
    }
  | LCB ICONST COMMA ICONST RCB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_QUANTIFIER,
          &[
              attr(Key::SQL_GRAPH_QUANTIFIER_LOWER, const_node(@2, AConstType::INTEGER)),
              attr(Key::SQL_GRAPH_QUANTIFIER_UPPER, const_node(@4, AConstType::INTEGER)),
          ],
      )
  }
  | LCB COMMA ICONST RCB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_QUANTIFIER,
          &[attr(Key::SQL_GRAPH_QUANTIFIER_UPPER, const_node(@3, AConstType::INTEGER))],
      )
  }
  | LCB ICONST COMMA RCB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_QUANTIFIER,
          &[attr(Key::SQL_GRAPH_QUANTIFIER_LOWER, const_node(@2, AConstType::INTEGER))],
      )
  }
  | LCB COMMA RCB { ctx.object_ex(@$, NodeType::OBJECT_SQL_GRAPH_QUANTIFIER, NO_NODES, false, false) }
    ;

sql_opt_col_id:
    sql_col_id { $1 }
  | %empty     { null() }
    ;

sql_opt_graph_label_expression:
    IS sql_graph_label_expression    { $2 }
  | COLON sql_graph_label_expression { $2 }
  | %empty                           { null() }
    ;

sql_graph_label_expression:
    sql_graph_label_term { $1 }
  | sql_graph_label_expression PIPE sql_graph_label_term {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION,
          &[
              attr(Key::SQL_GRAPH_LABEL_EXPRESSION_LEFT, $1),
              attr(Key::SQL_GRAPH_LABEL_EXPRESSION_RIGHT, $3),
              attr(Key::SQL_GRAPH_LABEL_EXPRESSION_DISJUNCTION, bool_node(@2, true)),
          ],
      )
  }
    ;

sql_graph_label_term:
    sql_graph_label_factor { $1 }
  | sql_graph_label_term AMPERSAND sql_graph_label_factor {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION,
          &[attr(Key::SQL_GRAPH_LABEL_EXPRESSION_LEFT, $1), attr(Key::SQL_GRAPH_LABEL_EXPRESSION_RIGHT, $3)],
      )
  }
    ;

sql_graph_label_factor:
    sql_graph_label_primary { $1 }
  | EXCLAMATION_MARK sql_graph_label_primary {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION,
          &[
              attr(Key::SQL_GRAPH_LABEL_EXPRESSION_LEFT, $2),
              attr(Key::SQL_GRAPH_LABEL_EXPRESSION_NEGATED, bool_node(@1, true)),
          ],
      )
  }
    ;

sql_graph_label_primary:
    sql_name {
        ctx.object(@$, NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION, &[attr(Key::SQL_GRAPH_LABEL_EXPRESSION_LABEL, $1)])
    }
  | MODULO {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_LABEL_EXPRESSION,
          &[attr(Key::SQL_GRAPH_LABEL_EXPRESSION_WILDCARD, bool_node(@1, true))],
      )
  }
  | LRB sql_graph_label_expression RRB { $2 }
    ;

sql_opt_graph_table_rows_clause:
    sql_graph_table_rows_clause { $1 }
  | %empty                     { null() }
    ;

sql_graph_table_rows_clause:
    ONE ROW PER MATCH {
        ctx.object(@$, NodeType::OBJECT_SQL_GRAPH_ROWS, &[attr(Key::SQL_GRAPH_ROWS_PER_MATCH, bool_node(@$, true))])
    }
  | ONE ROW PER STEP LRB sql_col_id COMMA sql_col_id COMMA sql_col_id RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GRAPH_ROWS,
          &[
              attr(Key::SQL_GRAPH_ROWS_PER_STEP, bool_node(loc(&[@1, @2, @3, @4]), true)),
              attr(Key::SQL_GRAPH_ROWS_SOURCE, $6),
              attr(Key::SQL_GRAPH_ROWS_EDGE, $8),
              attr(Key::SQL_GRAPH_ROWS_DESTINATION, $10),
          ],
      )
  }
    ;

sql_opt_graph_columns_clause:
    COLUMNS LRB sql_graph_columns_list RRB { ctx.array(@$, $3) }
  | %empty                                { null() }
    ;

sql_graph_columns_list:
    sql_graph_column { ctx.list(&[$1]) }
  | sql_graph_columns_list COMMA sql_graph_column {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_graph_column:
    sql_a_expr AS sql_col_label {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_RESULT_TARGET,
            &[attr(Key::SQL_RESULT_TARGET_VALUE, ctx.expression($1)), attr(Key::SQL_RESULT_TARGET_NAME, $3)],
        )
    }
  | sql_a_expr {
      ctx.object(@$, NodeType::OBJECT_SQL_RESULT_TARGET, &[attr(Key::SQL_RESULT_TARGET_VALUE, ctx.expression($1))])
  }
  | sql_columnref DOT_STAR_LA STAR sql_opt_graph_star_exclude {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_RESULT_TARGET,
          &[
              attr(Key::SQL_RESULT_TARGET_STAR, bool_node(@3, true)),
              attr(Key::SQL_RESULT_TARGET_VALUE, $1),
              attr(Key::SQL_RESULT_TARGET_EXCLUDE, $4),
          ],
      )
  }
    ;

sql_opt_graph_star_exclude:
    sql_graph_star_exclude { $1 }
  | %empty                 { null() }
    ;

sql_graph_star_exclude:
    EXCLUDE sql_columnref { ctx.array(@$, &[$2]) }
  | EXCLUDE LRB sql_graph_columnref_list RRB { ctx.array(@$, $3) }
    ;

sql_graph_columnref_list:
    sql_columnref { ctx.list(&[$1]) }
  | sql_graph_columnref_list COMMA sql_columnref {
      ctx.push_back($1, $3);
      $1
  }
    ;
