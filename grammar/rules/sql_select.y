// A complete SELECT statement looks like this.
//
// The rule returns either a single PGSelectStmt node or a tree of them,
// representing a set-operation tree.
//
// There is an ambiguity when a sub-SELECT is within an a_expr and there
// are excess parentheses: do the parentheses belong to the sub-SELECT or
// to the surrounding a_expr?  We don't really care, but bison wants to know.
// To resolve the ambiguity, we are careful to define the grammar so that
// the decision is staved off as long as possible: as long as we can keep
// absorbing parentheses into the sub-SELECT, we will do so, and only when
// it's no longer possible to do that will we decide that parens belong to
// the expression.    For example, in "SELECT (((SELECT 2)) + 3)" the extra
// parentheses are treated as part of the sub-select.  The necessity of doing
// it that way is shown by "SELECT (((SELECT 2)) UNION SELECT 2)".    Had we
// parsed "((SELECT 2))" as an a_expr, it'd be too late to go back to the
// SELECT viewpoint when we see the UNION.
//
// This approach is implemented by defining a nonterminal select_with_parens,
// which represents a SELECT with at least one outer layer of parentheses,
// and being careful to use select_with_parens, never LRB PGSelectStmt RRB,
// in the expression grammar.  We will then have shift-reduce conflicts
// which we can resolve in favor of always treating LRB <select> RRB as
// a select_with_parens.  To resolve the conflicts, the productions that
// conflict with the select_with_parens productions are manually given
// precedences lower than the precedence of RRB, thereby ensuring that we
// shift RRB (and then reduce to select_with_parens) rather than trying to
// reduce the inner <select> nonterminal to something else.  We use UMINUS
// precedence for this, which is a fairly arbitrary choice.
//
// To be able to define select_with_parens itself without ambiguity, we need
// a nonterminal select_no_parens that represents a SELECT structure with no
// outermost parentheses.  This is a little bit tedious, but it works.
//
// In non-expression contexts, we use PGSelectStmt which can represent a SELECT
// with or without outer parentheses.

sql_select_stmt:
    sql_select_no_parens    %prec UMINUS { $1 }
  | sql_select_with_parens  %prec UMINUS { $1 }
    ;

sql_select_with_parens:
    LRB sql_select_no_parens RRB    { $2 }
  | LRB sql_select_with_parens RRB  { $2 }
        ;

// This rule parses the equivalent of the standard's <query expression>.
// The duplicative productions are annoying, but hard to get rid of without
// creating shift/reduce conflicts.
//
//    The locking clause (FOR UPDATE etc) may be before or after LIMIT/OFFSET.
//    In <=7.2.X, LIMIT/OFFSET had to be after FOR UPDATE
//    We now support both orderings, but prefer LIMIT/OFFSET before the locking
// clause.
//    2002-08-28 bjm

sql_select_no_parens:
    sql_classical_select_no_parens { $1 }
    ;

sql_classical_select_no_parens:
    sql_simple_select { $1 }
  | sql_select_clause sql_sort_clause { ctx.concat2($1, &[attr(Key::SQL_SELECT_ORDER, $2)]) }
  | sql_select_clause sql_opt_sort_clause sql_for_locking_clause sql_opt_select_limit {
      ctx.concat3($1, $4, &[attr(Key::SQL_SELECT_ORDER, $2), attr(Key::SQL_SELECT_ROW_LOCKING, ctx.array(@3, $3))])
  }
  | sql_select_clause sql_opt_sort_clause sql_select_limit sql_opt_for_locking_clause {
      ctx.concat3($1, $3, &[attr(Key::SQL_SELECT_ORDER, $2), attr(Key::SQL_SELECT_ROW_LOCKING, ctx.array(@4, $4))])
  }
  | sql_with_clause sql_select_clause { ctx.concat2($1, $2) }
  | sql_with_clause sql_select_clause sql_sort_clause { ctx.concat3($1, $2, &[attr(Key::SQL_SELECT_ORDER, $3)]) }
  | sql_with_clause sql_select_clause sql_opt_sort_clause sql_for_locking_clause sql_opt_select_limit {
      ctx.concat4($1, $2, $5, &[attr(Key::SQL_SELECT_ORDER, $3), attr(Key::SQL_SELECT_ROW_LOCKING, ctx.array(@4, $4))])
  }
  | sql_with_clause sql_select_clause sql_opt_sort_clause sql_select_limit sql_opt_for_locking_clause {
      ctx.concat4($1, $2, $4, &[attr(Key::SQL_SELECT_ORDER, $3), attr(Key::SQL_SELECT_ROW_LOCKING, ctx.array(@5, $5))])
  }
    ;

sql_select_clause:
    sql_simple_select       { $1 }
  | sql_select_with_parens  { $1 }
    ;

// This rule parses SELECT statements that can appear within set operations,
// including UNION, INTERSECT and EXCEPT.  LRB and RRB can be used to specify
// the ordering of the set operations.    Without LRB and RRB we want the
// operations to be ordered per the precedence specs at the head of this file.
//
// As with select_no_parens, simple_select cannot have outer parentheses,
// but can have parenthesized subclauses.
//
// Note that sort clauses cannot be included at this level --- SQL requires
//        SELECT foo UNION SELECT bar ORDER BY baz
// to be parsed as
//        (SELECT foo UNION SELECT bar) ORDER BY baz
// not
//        SELECT foo UNION (SELECT bar ORDER BY baz)
// Likewise for WITH, FOR UPDATE and LIMIT.  Therefore, those clauses are
// described as part of the select_no_parens production, not simple_select.
// This does not limit functionality, because you can reintroduce these
// clauses inside parentheses.
//
// NOTE: only the leftmost component PGSelectStmt should have INTO.
// However, this is not checked by the grammar; parse analysis must check it.

sql_simple_select:
    SELECT sql_opt_all_clause sql_opt_target_list
        sql_into_clause sql_from_clause sql_where_clause
        sql_group_clause sql_having_clause sql_window_clause sql_sample_clause {
            ctx.list(
                &[
                    attr(Key::SQL_SELECT_ALL, $2),
                    attr(Key::SQL_SELECT_TARGETS, ctx.array(@3, $3)),
                    attr(Key::SQL_SELECT_INTO, $4),
                    attr(Key::SQL_SELECT_FROM, ctx.array(@5, $5)),
                    attr(Key::SQL_SELECT_WHERE, $6),
                    attr(Key::SQL_SELECT_GROUPS, ctx.array(@7, $7)),
                    attr(Key::SQL_SELECT_HAVING, $8),
                    attr(Key::SQL_SELECT_WINDOWS, ctx.array(@9, $9)),
                    attr(Key::SQL_SELECT_SAMPLE, $10),
                ],
            )
        }
  | SELECT sql_distinct_clause sql_target_list
        sql_into_clause sql_from_clause sql_where_clause
        sql_group_clause sql_having_clause sql_window_clause sql_sample_clause {
            ctx.list(
                &[
                    attr(Key::SQL_SELECT_DISTINCT, $2),
                    attr(Key::SQL_SELECT_TARGETS, ctx.array(@3, $3)),
                    attr(Key::SQL_SELECT_INTO, $4),
                    attr(Key::SQL_SELECT_FROM, ctx.array(@5, $5)),
                    attr(Key::SQL_SELECT_WHERE, $6),
                    attr(Key::SQL_SELECT_GROUPS, ctx.array(@7, $7)),
                    attr(Key::SQL_SELECT_HAVING, $8),
                    attr(Key::SQL_SELECT_WINDOWS, ctx.array(@9, $9)),
                    attr(Key::SQL_SELECT_SAMPLE, $10),
                ],
            )
        }
  | sql_values_clause { ctx.list(&[attr(Key::SQL_SELECT_VALUES, ctx.array(@1, $1))]) }
  | TABLE sql_relation_expr { ctx.list(&[attr(Key::SQL_SELECT_TABLE, ctx.object(@$, NodeType::OBJECT_SQL_TABLEREF, $2))]) }
  | sql_select_clause UNION sql_all_or_distinct sql_select_clause {
      let l = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
      let r = ctx.object(@4, NodeType::OBJECT_SQL_SELECT, $4);
      ctx.list(
          &[
              attr(Key::SQL_COMBINE_OPERATION, enum_node(@2, CombineOperation::UNION)),
              attr(Key::SQL_COMBINE_MODIFIER, $3),
              attr(Key::SQL_COMBINE_INPUT, ctx.array(@$, &[l, r])),
          ],
      )
  }
  | sql_select_clause INTERSECT sql_all_or_distinct sql_select_clause {
      let l = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
      let r = ctx.object(@4, NodeType::OBJECT_SQL_SELECT, $4);
      ctx.list(
          &[
              attr(Key::SQL_COMBINE_OPERATION, enum_node(@2, CombineOperation::INTERSECT)),
              attr(Key::SQL_COMBINE_MODIFIER, $3),
              attr(Key::SQL_COMBINE_INPUT, ctx.array(@$, &[l, r])),
          ],
      )
  }
  | sql_select_clause EXCEPT sql_all_or_distinct sql_select_clause {
      let l = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
      let r = ctx.object(@4, NodeType::OBJECT_SQL_SELECT, $4);
      ctx.list(
          &[
              attr(Key::SQL_COMBINE_OPERATION, enum_node(@2, CombineOperation::EXCEPT)),
              attr(Key::SQL_COMBINE_MODIFIER, $3),
              attr(Key::SQL_COMBINE_INPUT, ctx.array(@$, &[l, r])),
          ],
      )
  }
    ;

// SQL standard WITH clause looks like:
//
// WITH [ RECURSIVE ] <query name> [ (<column>,...) ]
//        AS (query) [ SEARCH or CYCLE clause ]
//
// We don't currently support the SEARCH or CYCLE clause.
//
// Recognizing WITH_LA here allows a CTE to be named TIME or ORDINALITY.

sql_with_clause:
    WITH sql_cte_list       { ctx.list(&[attr(Key::SQL_SELECT_WITH_CTES, ctx.array(@2, $2))]) }
  | WITH_LA sql_cte_list    { ctx.list(&[attr(Key::SQL_SELECT_WITH_CTES, ctx.array(@2, $2))]) }
  | WITH RECURSIVE sql_cte_list {
      ctx.list(
          &[
              attr(Key::SQL_SELECT_WITH_RECURSIVE, bool_node(@2, true)),
              attr(Key::SQL_SELECT_WITH_CTES, ctx.array(@3, $3)),
          ],
      )
  }
    ;

sql_cte_list:
    sql_common_element_expr                     { ctx.list(&[$1]) }
  | sql_cte_list COMMA sql_common_element_expr  {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_common_table_expr:
    sql_name AS LRB sql_preparable_stmt RRB {
        ctx.object(@$, NodeType::OBJECT_SQL_CTE, &[attr(Key::SQL_CTE_NAME, $1), attr(Key::SQL_CTE_STATEMENT, $4)])
    }
  | sql_name LRB sql_name_list RRB AS LRB sql_preparable_stmt RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CTE,
          &[
              attr(Key::SQL_CTE_NAME, $1),
              attr(Key::SQL_CTE_COLUMNS, ctx.array(@3, $3)),
              attr(Key::SQL_CTE_STATEMENT, $7),
          ],
      )
  }
    ;

sql_into_clause:
    INTO sql_opt_temp_table_name    { $2 }
  | %empty                          { null() }
    ;

// XXX PreparableStmt: select | insert | update | delete
sql_preparable_stmt:
    sql_select_stmt                 { ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1) }
    ;


// Redundancy here is needed to avoid shift/reduce conflicts,
// since TEMP is not a reserved word.  See also OptTemp.
sql_opt_temp_table_name:
    TEMPORARY sql_opt_table sql_qualified_name          { into_node(ctx, @$, enum_node(@1, TempType::DEFAULT), $3) }
  | TEMP sql_opt_table sql_qualified_name               { into_node(ctx, @$, enum_node(@1, TempType::DEFAULT), $3) }
  | LOCAL TEMPORARY sql_opt_table sql_qualified_name    { into_node(ctx, @$, enum_node(@1, TempType::LOCAL), $4) }
  | LOCAL TEMP sql_opt_table sql_qualified_name         { into_node(ctx, @$, enum_node(@1, TempType::LOCAL), $4) }
  | GLOBAL TEMPORARY sql_opt_table sql_qualified_name   { into_node(ctx, @$, enum_node(@1, TempType::GLOBAL), $4) }
  | GLOBAL TEMP sql_opt_table sql_qualified_name        { into_node(ctx, @$, enum_node(@1, TempType::GLOBAL), $4) }
  | UNLOGGED sql_opt_table sql_qualified_name           { into_node(ctx, @$, enum_node(@1, TempType::UNLOGGED), $3) }
  | TABLE sql_qualified_name                            { into_node(ctx, @$, enum_node(@1, TempType::NONE), $2) }
  | sql_qualified_name                                  { into_node(ctx, @$, enum_node(@1, TempType::NONE), $1) }
    ;

sql_opt_table:
    TABLE       {}
  | %empty      {}
    ;

sql_all_or_distinct:
    ALL         { enum_node(@1, CombineModifier::ALL) }
  | DISTINCT    { enum_node(@1, CombineModifier::DISTINCT) }
  | %empty      { null() }
    ;

// We use (NIL) as a placeholder to indicate that all target expressions
// should be placed in the DISTINCT list during parsetree analysis.

sql_distinct_clause:
    DISTINCT                            { ctx.array_ex(@$, NO_NODES, false, false) }
  | DISTINCT ON LRB sql_expr_list RRB   { ctx.array(@$, $4) }
    ;

sql_opt_all_clause:
    ALL                 { bool_node(@1, true) }
  | %empty              { null() }
    ;

sql_opt_sort_clause:
    sql_sort_clause     { $1 }
  | %empty              { null() }
    ;

sql_sort_clause:
    ORDER BY sql_sortby_list        { ctx.array(@$, $3) }
    ;

sql_sortby_list:
    sql_sortby                          { ctx.list(&[$1]) }
  | sql_sortby_list COMMA sql_sortby    {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_sortby:
    sql_a_expr USING sql_qual_all_op sql_opt_nulls_order {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ORDER,
            &[attr(Key::SQL_ORDER_VALUE, ctx.expression($1)), attr(Key::SQL_ORDER_NULLRULE, $4)],
        )
    }
  | sql_a_expr sql_opt_asc_desc sql_opt_nulls_order {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_ORDER,
          &[
              attr(Key::SQL_ORDER_VALUE, ctx.expression($1)),
              attr(Key::SQL_ORDER_DIRECTION, $2),
              attr(Key::SQL_ORDER_NULLRULE, $3),
          ],
      )
  }
    ;

sql_opt_asc_desc:
    ASC_P   { enum_node(@$, OrderDirection::ASCENDING) }
  | DESC_P  { enum_node(@$, OrderDirection::DESCENDING) }
  | %empty  { null() }
    ;

sql_opt_nulls_order:
    NULLS_LA FIRST_P    { enum_node(@$, OrderNullRule::NULLS_FIRST) }
  | NULLS_LA LAST_P     { enum_node(@$, OrderNullRule::NULLS_LAST) }
  | %empty              { null() }
    ;

sql_select_limit:
    sql_limit_clause sql_offset_clause  { ctx.concat2($1, $2) }
  | sql_offset_clause sql_limit_clause  { ctx.concat2($1, $2) }
  | sql_limit_clause                    { $1 }
  | sql_offset_clause                   { $1 }
    ;

sql_opt_select_limit:
    sql_select_limit  { $1 }
  | %empty            { ctx.list(NO_NODES) }
    ;

sql_limit_clause:
    LIMIT sql_select_limit_value { ctx.list(&[$2]) }
  | LIMIT sql_select_limit_value COMMA sql_select_offset_value { ctx.list(&[$2, attr(Key::SQL_SELECT_OFFSET, $4)]) }
    // SQL:2008 syntax
    // to avoid shift/reduce conflicts, handle the optional value with
    //   a separate production rather than an opt_ expression.  The fact
    //   that ONLY is fully reserved means that this way, we defer any
    //   decision about what rule reduces ROW or ROWS to the point where
    //   we can see the ONLY token in the lookahead slot.
    //  
  | FETCH sql_first_or_next sql_select_fetch_first_value sql_row_or_rows ONLY { ctx.list(&[attr(Key::SQL_SELECT_LIMIT, $3)]) }
  | FETCH sql_first_or_next sql_row_or_rows ONLY { ctx.list(&[attr(Key::SQL_SELECT_LIMIT, bool_node(@3, true))]) }
    ;

sql_offset_clause:
    OFFSET sql_select_offset_value { ctx.list(&[attr(Key::SQL_SELECT_OFFSET, $2)]) }
  | OFFSET sql_select_fetch_first_value sql_row_or_rows { ctx.list(&[attr(Key::SQL_SELECT_OFFSET, $2)]) }
    ;

sql_select_limit_value:
    sql_a_expr  { attr(Key::SQL_SELECT_LIMIT, ctx.expression($1)) }
  | ALL         { attr(Key::SQL_SELECT_LIMIT_ALL, bool_node(@1, true)) }
    ;

sql_select_offset_value:
    sql_a_expr  { ctx.expression($1) }
    ;

// Allowing full expressions without parentheses causes various parsing
// problems with the trailing ROW/ROWS key words.  SQL spec only calls for
// <simple value specification>, which is either a literal or a parameter (but
// an <SQL parameter reference> could be an identifier, bringing up conflicts
// with ROW/ROWS). We solve this by leveraging the presence of ONLY (see above)
// to determine whether the expression is missing rather than trying to make it
// optional in this rule.
//
// c_expr covers almost all the spec-required cases (and more), but it doesn't
// cover signed numeric literals, which are allowed by the spec. So we include
// those here explicitly. We need FCONST as well as ICONST because values that
// don't fit in the platform's "long", but do fit in bigint, should still be
// accepted here. (This is possible in 64-bit Windows as well as all 32-bit
// builds.)

sql_select_fetch_first_value:
    sql_c_expr              { ctx.expression($1) }
  | PLUS sql_i_or_f_const   { $2 }
  | MINUS sql_i_or_f_const  { ctx.expression(negate(ctx, @$, @1, $2)) }

        ;

sql_i_or_f_const:
    ICONST  { const_node(@$, AConstType::INTEGER) }
  | FCONST  { const_node(@$, AConstType::FLOAT) }
    ;

// noise words
sql_row_or_rows:
    ROW     {}
  | ROWS    {}
    ;

sql_first_or_next:
    FIRST_P {}
  | NEXT    {}
    ;


// ---------------------------------------------------------------------------
// Group clause

// This syntax for group_clause tries to follow the spec quite closely.
// However, the spec allows only column references, not expressions,
// which introduces an ambiguity between implicit row constructors
// (a,b) and lists of column references.
//
// We handle this by using the a_expr production for what the spec calls
// <ordinary grouping set>, which in the spec represents either one column
// reference or a parenthesized list of column references. Then, we check the
// top node of the a_expr to see if it's an implicit PGRowExpr, and if so, just
// grab and use the list, discarding the node. (this is done in parse analysis,
// not here)
//
// (we abuse the row_format field of PGRowExpr to distinguish implicit and
// explicit row constructors; it's debatable if anyone sanely wants to use them
// in a group clause, but if they have a reason to, we make it possible.)
//
// Each item in the group_clause list is either an expression tree or a
// PGGroupingSet node of some type.

sql_group_clause:
    GROUP_P BY sql_group_by_list    { $3 }
  | %empty                          { ctx.list(NO_NODES) }
    ;

sql_group_by_list:
    sql_group_by_item                           { ctx.list(&[$1]) }
  | sql_group_by_list COMMA sql_group_by_item   {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_group_by_item:
    sql_a_expr {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GROUP_BY_ITEM,
            &[
                attr(Key::SQL_GROUP_BY_ITEM_TYPE, enum_node(@$, GroupByItemType::EXPRESSION)),
                attr(Key::SQL_GROUP_BY_ITEM_ARG, ctx.expression($1)),
            ],
        )
    }
  | sql_empty_grouping_set {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GROUP_BY_ITEM,
          &[attr(Key::SQL_GROUP_BY_ITEM_TYPE, enum_node(@1, GroupByItemType::EMPTY))],
      )
  }
  | CUBE LRB sql_expr_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GROUP_BY_ITEM,
          &[
              attr(Key::SQL_GROUP_BY_ITEM_TYPE, enum_node(@1, GroupByItemType::CUBE)),
              attr(Key::SQL_GROUP_BY_ITEM_ARG, ctx.array(@3, $3)),
          ],
      )
  }
  | ROLLUP LRB sql_expr_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GROUP_BY_ITEM,
          &[
              attr(Key::SQL_GROUP_BY_ITEM_TYPE, enum_node(@1, GroupByItemType::ROLLUP)),
              attr(Key::SQL_GROUP_BY_ITEM_ARG, ctx.array(@3, $3)),
          ],
      )
  }
  | GROUPING SETS LRB sql_expr_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GROUP_BY_ITEM,
          &[
              attr(Key::SQL_GROUP_BY_ITEM_TYPE, enum_node(loc(&[@1, @2]), GroupByItemType::GROUPING_SETS)),
              attr(Key::SQL_GROUP_BY_ITEM_ARG, ctx.array(@4, $4)),
          ],
      )
  }
    ;

sql_empty_grouping_set:
    LRB RRB                 {}
    ;

// These hacks rely on setting precedence of CUBE and ROLLUP below that of LRB,
// so that they shift in these rules rather than reducing the conflicting
// unreserved_keyword rule.

sql_having_clause:
    HAVING sql_a_expr   { ctx.expression($2) }
  | %empty              { null() }
    ;

sql_for_locking_clause:
    sql_for_locking_items   { $1 }
  | FOR READ_P ONLY         {
      ctx.list(
          &[
              ctx.object(
                  @$,
                  NodeType::OBJECT_SQL_ROW_LOCKING,
                  &[attr(Key::SQL_ROW_LOCKING_STRENGTH, enum_node(@1, RowLockingStrength::READ_ONLY))],
              ),
          ],
      )
  }
    ;

sql_opt_for_locking_clause:
    sql_for_locking_clause  { ctx.list(&[ctx.array(@1, $1)]) }
  | %empty                  { ctx.list(NO_NODES) }
    ;

sql_for_locking_items:
    sql_for_locking_item                          { ctx.list(&[$1]) }
  | sql_for_locking_items sql_for_locking_item    {
      ctx.push_back($1, $2);
      $1
  }
    ;

sql_for_locking_item:
    sql_for_locking_strength sql_locked_rels_list sql_opt_nowait_or_skip {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ROW_LOCKING,
            &[
                attr(Key::SQL_ROW_LOCKING_STRENGTH, $1),
                attr(Key::SQL_ROW_LOCKING_OF, ctx.array(@2, $2)),
                attr(Key::SQL_ROW_LOCKING_BLOCK_BEHAVIOR, $3),
            ],
        )
    }
    ;

sql_for_locking_strength:
    FOR UPDATE          { enum_node(@$, RowLockingStrength::UPDATE) }
  | FOR NO KEY UPDATE   { enum_node(@$, RowLockingStrength::NO_KEY_UPDATE) }
  | FOR SHARE           { enum_node(@$, RowLockingStrength::SHARE) }
  | FOR KEY SHARE       { enum_node(@$, RowLockingStrength::KEY_SHARE) }
    ;

sql_locked_rels_list:
    OF sql_qualified_name_list  { $2 }
  | %empty                      { ctx.list(NO_NODES) }
    ;


sql_opt_nowait_or_skip:
    NOWAIT        { enum_node(@$, RowLockingBlockBehavior::NOWAIT) }
  | SKIP LOCKED   { enum_node(@$, RowLockingBlockBehavior::SKIP_LOCKED) }
  | %empty        { null() }
    ;

// We should allow ROW LRB expr_list RRB too, but that seems to require
// making VALUES a fully reserved word, which will probably break more apps
// than allowing the noise-word is worth.

sql_values_clause:
    VALUES LRB sql_expr_list RRB                    { ctx.list(&[ctx.array(@3, $3)]) }
  | sql_values_clause COMMA LRB sql_expr_list RRB   {
      ctx.push_back($1, ctx.array(@4, $4));
      $1
  }
    ;


// Clauses common to all Optimizable Stmts:
// from_clause      - allow list of both JOIN expressions and table names
// where_clause     - qualifications for joins or restrictions

sql_from_clause:
    FROM sql_from_list  { $2 }
  | FROM                {
      ctx.require_table_ref_after_from(@1);
      ctx.list(NO_NODES)
  }
  | %empty              { ctx.list(NO_NODES) }
    ;

sql_from_list:
    sql_table_ref                       { ctx.list(&[$1]) }
  | sql_from_list COMMA sql_table_ref   {
      ctx.push_back($1, $3);
      $1
  }
    ;

// table_ref is where an alias clause can be attached.
// XXX Andre
sql_table_ref:
    sql_relation_expr sql_opt_alias_clause sql_opt_tablesample_clause {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_TABLEREF,
            ctx.concat2($1, &[attr(Key::SQL_TABLEREF_ALIAS, $2), attr(Key::SQL_TABLEREF_SAMPLE, $3)]),
        )
    }
  | sql_func_table sql_func_alias_clause sql_opt_tablesample_clause {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TABLEREF,
          &[
              attr(Key::SQL_TABLEREF_ALIAS, $2),
              attr(Key::SQL_TABLEREF_SAMPLE, $3),
              attr(Key::SQL_TABLEREF_TABLE, $1),
          ],
      )
  }
  | sql_select_with_parens sql_opt_alias_clause sql_opt_tablesample_clause {
      let t = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TABLEREF,
          &[
              attr(Key::SQL_TABLEREF_ALIAS, $2),
              attr(Key::SQL_TABLEREF_SAMPLE, $3),
              attr(Key::SQL_TABLEREF_TABLE, t),
          ],
      )
  }
  | LATERAL_P sql_func_table sql_func_alias_clause {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TABLEREF,
          &[
              attr(Key::SQL_TABLEREF_LATERAL, bool_node(@1, true)),
              attr(Key::SQL_TABLEREF_ALIAS, $3),
              attr(Key::SQL_TABLEREF_TABLE, $2),
          ],
      )
  }
  | LATERAL_P sql_select_with_parens sql_opt_alias_clause {
      let t = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $2);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TABLEREF,
          &[
              attr(Key::SQL_TABLEREF_LATERAL, bool_node(@1, true)),
              attr(Key::SQL_TABLEREF_ALIAS, $3),
              attr(Key::SQL_TABLEREF_TABLE, t),
          ],
      )
  }
  | sql_joined_table {
      let t = ctx.object(@1, NodeType::OBJECT_SQL_JOINED_TABLE, $1);
      ctx.object(@$, NodeType::OBJECT_SQL_TABLEREF, &[attr(Key::SQL_TABLEREF_TABLE, t)])
  }
  | LRB sql_joined_table RRB sql_alias_clause {
      let t = ctx.object(@1, NodeType::OBJECT_SQL_JOINED_TABLE, $2);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TABLEREF,
          &[attr(Key::SQL_TABLEREF_ALIAS, $4), attr(Key::SQL_TABLEREF_TABLE, t)],
      )
  }
  | sql_graph_table_ref sql_opt_alias_clause {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TABLEREF,
          &[attr(Key::SQL_TABLEREF_ALIAS, $2), attr(Key::SQL_TABLEREF_TABLE, $1)],
      )
  }
    ;


// It may seem silly to separate joined_table from table_ref, but there is
// method in SQL's madness: if you don't do it this way you get reduce-
// reduce conflicts, because it's not clear to the parser generator whether
// to expect alias_clause after RRB or not.  For the same reason we must
// treat 'JOIN' and 'join_type JOIN' separately, rather than allowing
// join_type to expand to empty; if we try it, the parser generator can't
// figure out when to reduce an empty join_type right after table_ref.
//
// Note that a CROSS JOIN is the same as an unqualified
// INNER JOIN, and an INNER JOIN/ON has the same shape
// but a qualification expression to limit membership.
// A NATURAL JOIN implicitly matches column names between
// tables and the shape is determined by which columns are
// in common. We'll collect columns during the later transformations.

sql_joined_table:
    LRB sql_joined_table RRB { $2 }
  | sql_table_ref CROSS JOIN sql_table_ref {
      ctx.list(
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(loc(&[@2, @3]), JoinType::NONE)),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $4])),
          ],
      )
  }
  | sql_table_ref sql_join_type JOIN sql_table_ref sql_join_qual {
      ctx.concat2(
          $5,
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(loc(&[@2, @3]), $2)),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $4])),
          ],
      )
  }
  | sql_table_ref SEMI JOIN sql_table_ref sql_join_qual {
      ctx.concat2(
          $5,
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(loc(&[@2, @3]), JoinType::SEMI)),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $4])),
          ],
      )
  }
  | sql_table_ref ANTI JOIN sql_table_ref sql_join_qual {
      ctx.concat2(
          $5,
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(loc(&[@2, @3]), JoinType::ANTI)),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $4])),
          ],
      )
  }
  | sql_table_ref JOIN sql_table_ref sql_join_qual {
      ctx.concat2(
          $4,
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(@2, JoinType::INNER)),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $3])),
          ],
      )
  }
  | sql_table_ref NATURAL sql_join_type JOIN sql_table_ref {
      ctx.list(
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(loc(&[@2, @3]), merge_join(JoinType::NATURAL_, $3))),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $5])),
          ],
      )
  }
  | sql_table_ref NATURAL JOIN sql_table_ref {
      ctx.list(
          &[
              attr(Key::SQL_JOIN_TYPE, enum_node(loc(&[@2, @3]), JoinType::NATURAL_INNER)),
              attr(Key::SQL_JOIN_INPUT, ctx.array(@$, &[$1, $4])),
          ],
      )
  }
    ;

sql_alias_clause:
    AS sql_col_id LRB sql_name_list RRB {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ALIAS,
            &[attr(Key::SQL_ALIAS_NAME, $2), attr(Key::SQL_ALIAS_COLUMN_NAMES, ctx.array(@4, $4))],
        )
    }
  | AS sql_col_id_or_string { $2 }
  | sql_col_id LRB sql_name_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_ALIAS,
          &[attr(Key::SQL_ALIAS_NAME, $1), attr(Key::SQL_ALIAS_COLUMN_NAMES, ctx.array(@3, $3))],
      )
  }
  | sql_col_id { $1 }
    ;

sql_opt_alias_clause:
    sql_alias_clause    { $1 }
  | %empty              { null() }
    ;

// func_alias_clause can include both an PGAlias and a coldeflist, so we make it
// return a 2-element list that gets disassembled by calling production.
sql_func_alias_clause:
    sql_alias_clause { $1 }
  | AS LRB sql_table_func_element_list RRB { ctx.object(@$, NodeType::OBJECT_SQL_ALIAS, &[attr(Key::SQL_ALIAS_COLUMN_DEFS, ctx.array(@3, $3))]) }
  | AS sql_col_id LRB sql_table_func_element_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_ALIAS,
          &[attr(Key::SQL_ALIAS_NAME, $2), attr(Key::SQL_ALIAS_COLUMN_DEFS, ctx.array(@4, $4))],
      )
  }
  | sql_col_id LRB sql_table_func_element_list RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_ALIAS,
          &[attr(Key::SQL_ALIAS_NAME, $1), attr(Key::SQL_ALIAS_COLUMN_DEFS, ctx.array(@3, $3))],
      )
  }
  | %empty { null() }
    ;

sql_join_type:
    FULL sql_join_outer     { merge_join(JoinType::FULL, $2) }
  | LEFT sql_join_outer     { merge_join(JoinType::LEFT, $2) }
  | RIGHT sql_join_outer    { merge_join(JoinType::RIGHT, $2) }
  | INNER_P                 { JoinType::INNER }
    ;

/* OUTER is just noise... */
sql_join_outer:
    OUTER_P                 { JoinType::OUTER_ }
  | %empty                  { JoinType::NONE }
    ;

// JOIN qualification clauses
// Possibilities are:
//    USING ( column list ) allows only unqualified column names,
//                          which must match between tables.
//    ON expr allows more general qualifications.
//
// We return USING as a PGList node, while an ON-expr will not be a List.

sql_join_qual:
    USING LRB sql_name_list RRB   { ctx.list(&[attr(Key::SQL_JOIN_USING, ctx.array(loc(&[@2, @3, @4]), $3))]) }
  | ON sql_a_expr                 { ctx.list(&[attr(Key::SQL_JOIN_ON, ctx.expression($2))]) }
    ;

sql_relation_expr:
    sql_qualified_name              { ctx.list(&[attr(Key::SQL_TABLEREF_NAME, $1)]) }
  | sql_qualified_name STAR         { ctx.list(&[attr(Key::SQL_TABLEREF_NAME, $1), attr(Key::SQL_TABLEREF_NAME_STAR, bool_node(@2, true))]) }
  | ONLY sql_qualified_name         { ctx.list(&[attr(Key::SQL_TABLEREF_NAME, $2), attr(Key::SQL_TABLEREF_ONLY, bool_node(@1, true))]) }
  | ONLY LRB sql_qualified_name RRB { ctx.list(&[attr(Key::SQL_TABLEREF_NAME, $3), attr(Key::SQL_TABLEREF_ONLY, bool_node(@1, true))]) }
    ;

// Given "UPDATE foo set set ...", we have to decide without looking any
// further ahead whether the first "set" is an alias or the UPDATE's SET
// keyword.  Since "set" is allowed as a column name both interpretations
// are feasible.  We resolve the shift/reduce conflict by giving the first
// production a higher precedence than the SET token
// has, causing the parser to prefer to reduce, in effect assuming that the
// SET is not an alias.


// A sample count with an explicit unit
sql_sample_count_explicit:
	  FCONST MODULO     {
       ctx.list(
           &[
               attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@1, AConstType::FLOAT)),
               attr(Key::SQL_SAMPLE_COUNT_UNIT, enum_node(@2, SampleCountUnit::PERCENT)),
           ],
       )
   }
	| ICONST MODULO     {
     ctx.list(
         &[
             attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@1, AConstType::INTEGER)),
             attr(Key::SQL_SAMPLE_COUNT_UNIT, enum_node(@2, SampleCountUnit::PERCENT)),
         ],
     )
 }
	| FCONST PERCENT    {
     ctx.list(
         &[
             attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@1, AConstType::FLOAT)),
             attr(Key::SQL_SAMPLE_COUNT_UNIT, enum_node(@2, SampleCountUnit::PERCENT)),
         ],
     )
 }
	| ICONST PERCENT    {
     ctx.list(
         &[
             attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@1, AConstType::INTEGER)),
             attr(Key::SQL_SAMPLE_COUNT_UNIT, enum_node(@2, SampleCountUnit::PERCENT)),
         ],
     )
 }
	| ICONST ROWS       {
     ctx.list(
         &[
             attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@1, AConstType::INTEGER)),
             attr(Key::SQL_SAMPLE_COUNT_UNIT, enum_node(@2, SampleCountUnit::ROWS)),
         ],
     )
 }
	  ;

sql_sample_clause:
    USING SAMPLE sql_tablesample_entry  { ctx.object(@$, NodeType::OBJECT_SQL_SELECT_SAMPLE, $3) }
  | %empty                              { null() }

sql_opt_sample_func:
    sql_col_id                          { $1 }
  | %empty                              { null() }
		;

// A sample count, a count without a unit is a number of rows
sql_sample_count:
    sql_sample_count_explicit   { $1 }
  | ICONST            {
     ctx.list(
         &[
             attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@1, AConstType::INTEGER)),
             attr(Key::SQL_SAMPLE_COUNT_UNIT, enum_node(@1, SampleCountUnit::ROWS)),
         ],
     )
 }
    ;

sql_tablesample_entry:
	  sql_opt_sample_func LRB sql_sample_count_explicit RRB sql_opt_repeatable_clause {
       ctx.push_back($3, attr(Key::SQL_SAMPLE_FUNCTION, $1));
       ctx.push_back($3, attr(Key::SQL_SAMPLE_REPEAT, $5));
       $3
   }
	| sql_opt_sample_func LRB ICONST RRB sql_opt_repeatable_clause {
       // A count without a unit is a percentage for the sampling methods of the SQL standard
       let unit = ctx.bare_sample_unit(&$1, @3);
       let list = ctx.list(&[attr(Key::SQL_SAMPLE_COUNT_VALUE, const_node(@3, AConstType::INTEGER)), attr(Key::SQL_SAMPLE_COUNT_UNIT, unit)]);
       ctx.push_back(list, attr(Key::SQL_SAMPLE_FUNCTION, $1));
       ctx.push_back(list, attr(Key::SQL_SAMPLE_REPEAT, $5));
       list
   }
	| sql_sample_count { $1 }
	| sql_sample_count LRB sql_col_id RRB {
     ctx.push_back($1, attr(Key::SQL_SAMPLE_FUNCTION, $3));
     $1
 }
	| sql_sample_count LRB sql_col_id COMMA ICONST RRB {
     ctx.push_back($1, attr(Key::SQL_SAMPLE_FUNCTION, $3));
     ctx.push_back($1, attr(Key::SQL_SAMPLE_SEED, const_node(@5, AConstType::INTEGER)));
     $1
 }
	  ;

sql_tablesample_clause:
    TABLESAMPLE sql_tablesample_entry { ctx.object(@$, NodeType::OBJECT_SQL_TABLEREF_SAMPLE, $2) }
		;

sql_opt_tablesample_clause:
		sql_tablesample_clause  { $1 }
  | %empty                      { null() }
		;

sql_opt_repeatable_clause:
    REPEATABLE LRB ICONST RRB   { const_node(@3, AConstType::INTEGER) }
  | %empty                      { null() }
		;

// func_table represents a function invocation in a FROM list. It can be
// a plain function call, like "foo(...)", or a ROWS FROM expression with
// one or more function calls, "ROWS FROM (foo(...), bar(...))",
// optionally with WITH ORDINALITY attached.
// In the ROWS FROM syntax, a column list can be given for each
// function, for example:
//     ROWS FROM (foo() AS (foo_res_a text, foo_res_b text),
//                bar() AS (bar_res_a text, bar_res_b text))
// It's also possible to attach a column list to the PGRangeFunction
// as a whole, but that's handled by the table_ref production.

sql_func_table:
    sql_func_expr_windowless sql_opt_ordinality {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_FUNCTION_TABLE,
            &[attr(Key::SQL_FUNCTION_TABLE_FUNCTION, $1), attr(Key::SQL_FUNCTION_TABLE_WITH_ORDINALITY, $2)],
        )
    }
  | ROWS FROM LRB sql_rowsfrom_list RRB sql_opt_ordinality  {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_TABLE,
          &[
              attr(Key::SQL_FUNCTION_TABLE_WITH_ORDINALITY, $6),
              attr(Key::SQL_FUNCTION_TABLE_ROWS_FROM, ctx.array(@4, $4)),
          ],
      )
  }
    ;

sql_rowsfrom_item:
    sql_func_expr_windowless sql_opt_col_def_list {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ROWSFROM_ITEM,
            &[attr(Key::SQL_ROWSFROM_ITEM_FUNCTION, $1), attr(Key::SQL_ROWSFROM_ITEM_COLUMNS, $2)],
        )
    }
    ;

sql_rowsfrom_list:
    sql_rowsfrom_item                           { ctx.list(&[$1]) }
  | sql_rowsfrom_list COMMA sql_rowsfrom_item   {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_opt_col_def_list:
    AS LRB sql_table_func_element_list RRB    { ctx.array(@$, $3) }
  | %empty                                    { null() }
    ;

sql_opt_ordinality:
    WITH_LA ORDINALITY    { bool_node(@$, true) }
  | %empty                { bool_node(@$, false) }
    ;


sql_where_clause:
    WHERE sql_a_expr      { ctx.expression($2) }
  | WHERE                 { null() }
  | %empty                { null() }
    ;

/* variant for UPDATE and DELETE */
sql_table_func_element_list:
    sql_table_func_element                                  { ctx.list(&[$1]) }
  | sql_table_func_element_list COMMA sql_table_func_element  {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_table_func_element:
    sql_col_id sql_typename sql_opt_collate_clause {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_COLUMN_DEF,
            &[
                attr(Key::SQL_COLUMN_DEF_NAME, $1),
                attr(Key::SQL_COLUMN_DEF_TYPE, $2),
                attr(Key::SQL_COLUMN_DEF_COLLATE, $3),
            ],
        )
    }
    ;

sql_opt_collate_clause:
    COLLATE sql_any_name  { ctx.array(@$, $2) }
  | %empty                { null() }
    ;


// Type syntax
//  SQL introduces a large amount of type-specific syntax.
//  Define individual clauses to handle these cases, and use
//   the generic case to handle regular type-extensible Postgres syntax.
//  - thomas 1997-10-10

sql_typename:
    sql_simple_typename sql_opt_array_bounds {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_TYPENAME,
            &[attr(Key::SQL_TYPENAME_TYPE, $1), attr(Key::SQL_TYPENAME_ARRAY, ctx.array(@2, $2))],
        )
    }
  | SETOF sql_simple_typename sql_opt_array_bounds {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPENAME,
          &[
              attr(Key::SQL_TYPENAME_TYPE, $2),
              attr(Key::SQL_TYPENAME_ARRAY, ctx.array(@3, $3)),
              attr(Key::SQL_TYPENAME_SETOF, bool_node(@1, true)),
          ],
      )
  }
    // SQL standard syntax, currently only one-dimensional
  | sql_simple_typename ARRAY LSB ICONST RSB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPENAME,
          &[
              attr(Key::SQL_TYPENAME_TYPE, $1),
              attr(
                  Key::SQL_TYPENAME_ARRAY,
                  ctx.array(loc(&[@2, @3, @4, @5]), &[const_node(@4, AConstType::INTEGER)]),
              ),
          ],
      )
  }
  | SETOF sql_simple_typename ARRAY LSB ICONST RSB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPENAME,
          &[
              attr(Key::SQL_TYPENAME_TYPE, $2),
              attr(
                  Key::SQL_TYPENAME_ARRAY,
                  ctx.array(loc(&[@3, @4, @5, @6]), &[const_node(@5, AConstType::INTEGER)]),
              ),
              attr(Key::SQL_TYPENAME_SETOF, bool_node(@1, true)),
          ],
      )
  }
  | sql_simple_typename ARRAY {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPENAME,
          &[
              attr(Key::SQL_TYPENAME_TYPE, $1),
              attr(Key::SQL_TYPENAME_ARRAY, ctx.array_ex(@2, NO_NODES, false, false)),
          ],
      )
  }
  | SETOF sql_simple_typename ARRAY {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPENAME,
          &[
              attr(Key::SQL_TYPENAME_TYPE, $2),
              attr(Key::SQL_TYPENAME_ARRAY, ctx.array_ex(@3, NO_NODES, false, false)),
              attr(Key::SQL_TYPENAME_SETOF, bool_node(@1, true)),
          ],
      )
  }
    ;

sql_opt_array_bounds:
    // Keep an explicit marker for unbounded dimensions so formatting does not drop [].
    sql_opt_array_bounds LSB RSB            {
        ctx.push_back($1, bool_node(loc(&[@2, @3]), true));
        $1
    }
  | sql_opt_array_bounds LSB ICONST RSB     {
      ctx.push_back($1, const_node(@3, AConstType::INTEGER));
      $1
  }
  | %empty                                  { ctx.list(NO_NODES) }
    ;

sql_simple_typename:
    sql_generic_type                    { $1 }
  | ARRAY LRB sql_typename RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_GENERIC_TYPE,
          &[
              attr(Key::SQL_GENERIC_TYPE_NAME, ctx.name_from_keyword(@1, "array")),
              attr(Key::SQL_GENERIC_TYPE_MODIFIERS, ctx.array(loc(&[@2, @3, @4]), &[$3])),
          ],
      )
  }
  | ROW LRB sql_table_func_element_list RRB { ctx.object(@$, NodeType::OBJECT_SQL_ROW_TYPE, &[attr(Key::SQL_ROW_TYPE_FIELDS, ctx.array(@3, $3))]) }
  | sql_numeric                         { $1 }
  | sql_bit                             { $1 }
  | sql_const_character                 { $1 }
  | sql_const_datetime                  { $1 }
  | sql_const_interval sql_opt_interval {
      let mut yy_2 = $2;
      if yy_2 == null() {
          yy_2 = ctx.object(@$, NodeType::OBJECT_SQL_INTERVAL_TYPE, NO_NODES);
      }
      yy_2
  }
  | sql_const_interval LRB ICONST RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_PRECISION, const_node(@3, AConstType::INTEGER))],
      )
  }
    ;

// We have a separate ConstTypename to allow defaulting fixed-length
// types such as CHAR() and BIT() to an unspecified length.
// SQL9x requires that these default to a length of one, but this
// makes no sense for constructs like CHAR 'hi' and BIT '0101',
// where there is an obvious better choice to make.
// Note that ConstInterval is not included here since it must
// be pushed up higher in the rules to accommodate the postfix
// options (e.g. INTERVAL '1' YEAR). Likewise, we have to handle
// the generic-type-name case in AExprConst to avoid premature
// reduce/reduce conflicts against function names.

sql_const_typename:
    sql_numeric         { $1 }
  | sql_const_bit       { $1 }
  | sql_character       { $1 }
  | sql_const_datetime  { $1 }
    ;

// GenericType covers all type names that don't have special syntax mandated
// by the standard, including qualified names.  We also allow type modifiers.
// To avoid parsing conflicts against function invocations, the modifiers
// have to be shown as expr_list here, but parse analysis will only accept
// constants for them.

sql_generic_type:
    sql_type_function_name sql_opt_type_modifiers {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GENERIC_TYPE,
            &[attr(Key::SQL_GENERIC_TYPE_NAME, $1), attr(Key::SQL_GENERIC_TYPE_MODIFIERS, ctx.array(@2, $2))],
        )
    }
    ;

sql_opt_type_modifiers:
    LRB sql_expr_list RRB   { $2 }
  | %empty                  { ctx.list(NO_NODES) }
    ;

// SQL numeric data types

sql_numeric:
    INT_P       { enum_node(@1, NumericType::INT4) }
  | INTEGER     { enum_node(@1, NumericType::INT4) }
  | SMALLINT    { enum_node(@1, NumericType::INT2) }
  | BIGINT      { enum_node(@1, NumericType::INT8) }
  | REAL        { enum_node(@1, NumericType::FLOAT4) }
  | FLOAT_P sql_opt_float   { enum_node(@$, $2) }
  | DOUBLE_P PRECISION      { enum_node(@$, NumericType::FLOAT8) }
  | DECIMAL_P sql_opt_type_modifiers {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_NUMERIC_TYPE,
          &[
              attr(Key::SQL_NUMERIC_TYPE_BASE, enum_node(@1, NumericType::NUMERIC)),
              attr(Key::SQL_NUMERIC_TYPE_MODIFIERS, ctx.array(@2, $2)),
          ],
      )
  }
  | DEC sql_opt_type_modifiers {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_NUMERIC_TYPE,
          &[
              attr(Key::SQL_NUMERIC_TYPE_BASE, enum_node(@1, NumericType::NUMERIC)),
              attr(Key::SQL_NUMERIC_TYPE_MODIFIERS, ctx.array(@2, $2)),
          ],
      )
  }
  | NUMERIC sql_opt_type_modifiers {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_NUMERIC_TYPE,
          &[
              attr(Key::SQL_NUMERIC_TYPE_BASE, enum_node(@1, NumericType::NUMERIC)),
              attr(Key::SQL_NUMERIC_TYPE_MODIFIERS, ctx.array(@2, $2)),
          ],
      )
  }
  | BOOLEAN_P   { enum_node(@1, NumericType::BOOL) }
    ;

sql_opt_float:
    LRB ICONST RRB  { ctx.read_float_type(@2) }
  | %empty          { NumericType::FLOAT4 }
    ;

// SQL bit-field data types
// The following implements BIT() and BIT VARYING().

sql_bit:
    sql_bit_with_length     { $1 }
  | sql_bit_without_length  { $1 }
    ;

// ConstBit is like Bit except "BIT" defaults to unspecified length
// See notes for ConstCharacter, which addresses same issue for "CHAR"
// Andre: XXX Relevant for DashQL?

sql_const_bit:
    sql_bit_with_length     { $1 }
  | sql_bit_without_length  { $1 }
    ;

sql_bit_with_length:
    BIT sql_opt_varying LRB sql_a_expr RRB {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_BIT_TYPE,
            &[
                attr(Key::SQL_BIT_TYPE_VARYING, bool_node(@2, $2)),
                attr(Key::SQL_BIT_TYPE_LENGTH, ctx.expression($4)),
            ],
        )
    }
    ;

sql_bit_without_length:
    BIT sql_opt_varying { ctx.object(@$, NodeType::OBJECT_SQL_BIT_TYPE, &[attr(Key::SQL_BIT_TYPE_VARYING, bool_node(@2, $2))]) }
    ;


// SQL character data types
// The following implements CHAR() and VARCHAR().

sql_character:
    sql_character_with_length     { ctx.object(@$, NodeType::OBJECT_SQL_CHARACTER_TYPE, $1) }
  | sql_character_without_length  { ctx.object(@$, NodeType::OBJECT_SQL_CHARACTER_TYPE, $1) }
    ;

sql_const_character:
    sql_character_with_length     { ctx.object(@$, NodeType::OBJECT_SQL_CHARACTER_TYPE, $1) }
  | sql_character_without_length  { ctx.object(@$, NodeType::OBJECT_SQL_CHARACTER_TYPE, $1) }
    ;

sql_character_with_length:
    sql_character_without_length LRB ICONST RRB  {
        ctx.push_back($1, attr(Key::SQL_CHARACTER_TYPE_LENGTH, const_node(@3, AConstType::INTEGER)));
        $1
    }
    ;

sql_character_without_length:
    CHARACTER sql_opt_varying           {
        ctx.list(
            &[
                attr(
                    Key::SQL_CHARACTER_TYPE,
                    enum_node(@$, if $2 { CharacterType::VARCHAR } else { CharacterType::BLANK_PADDED_CHAR }),
                ),
            ],
        )
    }
  | CHAR_P sql_opt_varying              {
      ctx.list(
          &[
              attr(
                  Key::SQL_CHARACTER_TYPE,
                  enum_node(@$, if $2 { CharacterType::VARCHAR } else { CharacterType::BLANK_PADDED_CHAR }),
              ),
          ],
      )
  }
  | VARCHAR                             { ctx.list(&[attr(Key::SQL_CHARACTER_TYPE, enum_node(@$, CharacterType::VARCHAR))]) }
  | NATIONAL CHARACTER sql_opt_varying  {
      ctx.list(
          &[
              attr(
                  Key::SQL_CHARACTER_TYPE,
                  enum_node(@$, if $3 { CharacterType::VARCHAR } else { CharacterType::BLANK_PADDED_CHAR }),
              ),
          ],
      )
  }
  | NATIONAL CHAR_P sql_opt_varying     {
      ctx.list(
          &[
              attr(
                  Key::SQL_CHARACTER_TYPE,
                  enum_node(@$, if $3 { CharacterType::VARCHAR } else { CharacterType::BLANK_PADDED_CHAR }),
              ),
          ],
      )
  }
  | NCHAR sql_opt_varying               {
      ctx.list(
          &[
              attr(
                  Key::SQL_CHARACTER_TYPE,
                  enum_node(@$, if $2 { CharacterType::VARCHAR } else { CharacterType::BLANK_PADDED_CHAR }),
              ),
          ],
      )
  }
    ;

sql_opt_varying:
    VARYING       { true }
  | %empty        { false }
    ;

// SQL date/time types

sql_const_datetime:
    TIMESTAMP LRB ICONST RRB sql_opt_timezone {
        ctx.object_ex(
            @$,
            NodeType::OBJECT_SQL_TIMESTAMP_TYPE,
            &[
                attr(Key::SQL_TIME_TYPE_PRECISION, const_node(@3, AConstType::INTEGER)),
                attr(Key::SQL_TIME_TYPE_WITH_TIMEZONE, $5),
            ],
            false,
            false,
        )
    }
  | TIMESTAMP sql_opt_timezone {
      ctx.object_ex(@$, NodeType::OBJECT_SQL_TIMESTAMP_TYPE, &[attr(Key::SQL_TIME_TYPE_WITH_TIMEZONE, $2)], false, false)
  }
  | TIME LRB ICONST RRB sql_opt_timezone {
      ctx.object_ex(
          @$,
          NodeType::OBJECT_SQL_TIME_TYPE,
          &[
              attr(Key::SQL_TIME_TYPE_PRECISION, const_node(@3, AConstType::INTEGER)),
              attr(Key::SQL_TIME_TYPE_WITH_TIMEZONE, $5),
          ],
          false,
          false,
      )
  }
  | TIME sql_opt_timezone {
      ctx.object_ex(@$, NodeType::OBJECT_SQL_TIME_TYPE, &[attr(Key::SQL_TIME_TYPE_WITH_TIMEZONE, $2)], false, false)
  }
    ;

sql_const_interval:
    INTERVAL          {}
    ;

sql_opt_timezone:
    WITH_LA TIME ZONE { bool_node(@$, true) }
  | WITHOUT TIME ZONE { bool_node(@$, false) }
  | %empty            { null() }
    ;

sql_opt_interval:
    YEAR_P {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_INTERVAL_TYPE,
            &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::YEAR))],
        )
    }
  | MONTH_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::MONTH))],
      )
  }
  | DAY_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::DAY))],
      )
  }
  | HOUR_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::HOUR))],
      )
  }
  | MINUTE_P  {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::MINUTE))],
      )
  }
  | sql_interval_second {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[
              attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::SECOND)),
              attr(Key::SQL_INTERVAL_PRECISION, $1),
          ],
      )
  }
  | YEAR_P TO MONTH_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::YEAR_TO_MONTH))],
      )
  }
  | DAY_P TO HOUR_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::DAY_TO_HOUR))],
      )
  }
  | DAY_P TO MINUTE_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::DAY_TO_MINUTE))],
      )
  }
  | DAY_P TO sql_interval_second {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[
              attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::DAY_TO_SECOND)),
              attr(Key::SQL_INTERVAL_PRECISION, $3),
          ],
      )
  }
  | HOUR_P TO MINUTE_P {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::HOUR_TO_MINUTE))],
      )
  }
  | HOUR_P TO sql_interval_second {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[
              attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::HOUR_TO_SECOND)),
              attr(Key::SQL_INTERVAL_PRECISION, $3),
          ],
      )
  }
  | MINUTE_P TO sql_interval_second {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_INTERVAL_TYPE,
          &[
              attr(Key::SQL_INTERVAL_TYPE, enum_node(@$, IntervalType::MINUTE_TO_SECOND)),
              attr(Key::SQL_INTERVAL_PRECISION, $3),
          ],
      )
  }
  | %empty  { null() }
    ;

sql_interval_second:
    SECOND_P                { null() }
  | SECOND_P LRB ICONST RRB { const_node(@3, AConstType::INTEGER) }
    ;


// ---------------------------------------------------------------------------
// Expression grammar

// General expressions
// This is the heart of the expression syntax.
//
// We have two expression types: a_expr is the unrestricted kind, and
// b_expr is a subset that must be used in some places to avoid shift/reduce
// conflicts.  For example, we can't do BETWEEN as "BETWEEN a_expr AND a_expr"
// because that use of AND conflicts with AND as a boolean operator.  So,
// b_expr is used in BETWEEN and we remove boolean keywords from b_expr.
//
// Note that LRB a_expr RRB is a b_expr, so an unrestricted expression can
// always be used by surrounding it with parens.
//
// c_expr is all the productions that are common to a_expr and b_expr;
// it's factored out just to eliminate redundant coding.
//
// Be careful of productions involving more than one terminal token.
// By default, bison will assign such productions the precedence of their
// last terminal, but in nearly all cases you want it to be the precedence
// of the first terminal instead; otherwise you will not get the behavior
// you expect!  So we use %prec annotations freely to set precedences.

sql_a_expr:
    error      {
        ctx.clear_lookahead();
        null()
    }
  | sql_c_expr { $1 }
  | sql_a_expr TYPECAST sql_typename {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPECAST_EXPRESSION,
          &[attr(Key::SQL_TYPECAST_VALUE, ctx.expression($1)), attr(Key::SQL_TYPECAST_TYPE, $3)],
      )
  }
  | sql_a_expr COLLATE sql_any_name                             { expr2(ctx, @$, enum_node(@2, ExprFunc::COLLATE), $1, ctx.array(@3, $3)) }
  | sql_a_expr AT TIME ZONE sql_a_expr      %prec AT            { expr2(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::AT_TIMEZONE), $1, $5) }

  // These operators must be called out explicitly in order to make use
  // of bison's automatic operator-precedence handling.  All other
  // operator names are handled by the generic productions using "Op",
  // below; and all those operators will have the same precedence.
  // 
  // If you add more explicitly-known operators, be sure to add them
  // also to b_expr and to the ExpressionOperator list below.

  | PLUS sql_a_expr %prec UMINUS    { $2 }
  | MINUS sql_a_expr %prec UMINUS   { negate(ctx, @$, @1, $2) }
  | sql_a_expr PLUS sql_a_expr      { expr2(ctx, @$, enum_node(@2, ExprFunc::PLUS), $1, $3) }
  | sql_a_expr MINUS sql_a_expr     { expr2(ctx, @$, enum_node(@2, ExprFunc::MINUS), $1, $3) }
  | sql_a_expr STAR sql_a_expr      { expr2(ctx, @$, enum_node(@2, ExprFunc::MULTIPLY), $1, $3) }
  | sql_a_expr DIVIDE sql_a_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::DIVIDE), $1, $3) }
  | sql_a_expr MODULO sql_a_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::MODULUS), $1, $3) }
  | sql_a_expr CIRCUMFLEX sql_a_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::XOR), $1, $3) }
  | sql_a_expr LESS_THAN sql_a_expr     { expr2(ctx, @$, enum_node(@2, ExprFunc::LESS_THAN), $1, $3) }
  | sql_a_expr GREATER_THAN sql_a_expr  { expr2(ctx, @$, enum_node(@2, ExprFunc::GREATER_THAN), $1, $3) }
  | sql_a_expr EQUALS sql_a_expr        { expr2(ctx, @$, enum_node(@2, ExprFunc::EQUAL), $1, $3) }
  | sql_a_expr LESS_EQUALS sql_a_expr       { expr2(ctx, @$, enum_node(@2, ExprFunc::LESS_EQUAL), $1, $3) }
  | sql_a_expr GREATER_EQUALS sql_a_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::GREATER_EQUAL), $1, $3) }
  | sql_a_expr NOT_EQUALS sql_a_expr        { expr2(ctx, @$, enum_node(@2, ExprFunc::NOT_EQUAL), $1, $3) }
  | sql_a_expr sql_qual_op sql_a_expr   %prec Op          { expr2(ctx, @$, $2, $1, $3) }
  | sql_qual_op sql_a_expr              %prec Op          { expr1(ctx, @$, $1, $2) }
  | sql_a_expr sql_qual_op              %prec POSTFIXOP   { expr_postfix(ctx, @$, $2, $1) }
  | sql_a_expr AND sql_a_expr               { expr2(ctx, @$, enum_node(@2, ExprFunc::AND), $1, $3) }
  | sql_a_expr OR sql_a_expr                { expr2(ctx, @$, enum_node(@2, ExprFunc::OR), $1, $3) }
  | NOT sql_a_expr                          { expr1(ctx, @$, enum_node(@1, ExprFunc::NOT), $2) }
  | NOT_LA sql_a_expr   %prec NOT           { expr1(ctx, @$, enum_node(@1, ExprFunc::NOT), $2) }
  | sql_a_expr GLOB sql_a_expr  %prec GLOB  { expr2(ctx, @$, enum_node(@2, ExprFunc::GLOB), $1, $3) }
  | sql_a_expr LIKE sql_a_expr                                              { expr2(ctx, @$, enum_node(@2, ExprFunc::LIKE), $1, $3) }
  | sql_a_expr LIKE sql_a_expr ESCAPE sql_a_expr            %prec LIKE      { expr3(ctx, @$, enum_node(@2, ExprFunc::LIKE), $1, $3, $5) }
  | sql_a_expr NOT_LA LIKE sql_a_expr                       %prec NOT_LA    { expr2(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::NOT_LIKE), $1, $4) }
  | sql_a_expr NOT_LA LIKE sql_a_expr ESCAPE sql_a_expr     %prec NOT_LA    { expr3(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::NOT_LIKE), $1, $4, $6) }
  | sql_a_expr ILIKE sql_a_expr                                             { expr2(ctx, @$, enum_node(@3, ExprFunc::ILIKE), $1, $3) }
  | sql_a_expr ILIKE sql_a_expr ESCAPE sql_a_expr           %prec ILIKE     { expr3(ctx, @$, enum_node(@3, ExprFunc::ILIKE), $1, $3, $5) }
  | sql_a_expr NOT_LA ILIKE sql_a_expr                      %prec NOT_LA    { expr2(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::NOT_ILIKE), $1, $4) }
  | sql_a_expr NOT_LA ILIKE sql_a_expr ESCAPE sql_a_expr    %prec NOT_LA    { expr3(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::NOT_ILIKE), $1, $4, $6) }
  | sql_a_expr SIMILAR TO sql_a_expr                        %prec SIMILAR   { expr2(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::SIMILAR_TO), $1, $4) }
  | sql_a_expr SIMILAR TO sql_a_expr ESCAPE sql_a_expr      %prec SIMILAR   { expr3(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::SIMILAR_TO), $1, $4, $6) }
  | sql_a_expr NOT_LA SIMILAR TO sql_a_expr                 %prec NOT_LA    { expr2(ctx, @$, enum_node(loc(&[@3, @4]), ExprFunc::NOT_SIMILAR_TO), $1, $5) }
  | sql_a_expr NOT_LA SIMILAR TO sql_a_expr ESCAPE sql_a_expr     %prec NOT_LA  { expr3(ctx, @$, enum_node(loc(&[@3, @4]), ExprFunc::NOT_SIMILAR_TO), $1, $5, $7) }

  | sql_a_expr IS NULL_P        %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::IS_NULL), $1) }
  | sql_a_expr ISNULL                       { expr1(ctx, @$, enum_node(@2, ExprFunc::IS_NULL), $1) }
  | sql_a_expr IS NOT NULL_P    %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::NOT_NULL), $1) }
  | sql_a_expr NOT NULL_P                   { expr1(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::NOT_NULL), $1) }
  | sql_a_expr NOTNULL                      { expr1(ctx, @$, enum_node(@2, ExprFunc::NOT_NULL), $1) }

  | sql_row OVERLAPS sql_row { expr2(ctx, @$, enum_node(@2, ExprFunc::OVERLAPS), $1, $3) }
  | sql_a_expr IS TRUE_P                            %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::IS_TRUE), $1) }
  | sql_a_expr IS NOT TRUE_P                        %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::IS_NOT_TRUE), $1) }
  | sql_a_expr IS FALSE_P                           %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::IS_FALSE), $1) }
  | sql_a_expr IS NOT FALSE_P                       %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::IS_NOT_FALSE), $1) }
  | sql_a_expr IS UNKNOWN                           %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::IS_UNKNOWN), $1) }
  | sql_a_expr IS NOT UNKNOWN                       %prec IS    { expr1(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::IS_NOT_UNKNOWN), $1) }
  | sql_a_expr IS DISTINCT FROM sql_a_expr          %prec IS    { expr2(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::IS_DISTINCT_FROM), $1, $5) }
  | sql_a_expr IS NOT DISTINCT FROM sql_a_expr      %prec IS    { expr2(ctx, @$, enum_node(loc(&[@2, @3, @4, @5]), ExprFunc::IS_NOT_DISTINCT_FROM), $1, $6) }
  | sql_a_expr IS OF LRB sql_type_list RRB          %prec IS {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPETEST_EXPRESSION,
          &[
              attr(Key::SQL_TYPETEST_VALUE, ctx.expression($1)),
              attr(Key::SQL_TYPETEST_TYPES, ctx.array(@5, $5)),
          ],
      )
  }
  | sql_a_expr IS NOT OF LRB sql_type_list RRB      %prec IS {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPETEST_EXPRESSION,
          &[
              attr(Key::SQL_TYPETEST_NEGATE, bool_node(@3, true)),
              attr(Key::SQL_TYPETEST_VALUE, ctx.expression($1)),
              attr(Key::SQL_TYPETEST_TYPES, ctx.array(@6, $6)),
          ],
      )
  }
  | sql_a_expr BETWEEN sql_opt_asymmetric sql_b_expr AND sql_a_expr         %prec BETWEEN   {
      expr3(
          ctx,
          @$,
          // Plain BETWEEN is asymmetric, the SYMMETRIC keyword has its own rule
          enum_node(loc(&[@2, @3]), ExprFunc::BETWEEN_ASYMMETRIC),
          $1,
          $4,
          $6,
      )
  }
  | sql_a_expr NOT_LA BETWEEN sql_opt_asymmetric sql_b_expr AND sql_a_expr  %prec NOT_LA    {
      expr3(
          ctx,
          @$,
          enum_node(loc(&[@2, @3, @4]), ExprFunc::NOT_BETWEEN_ASYMMETRIC),
          $1,
          $5,
          $7,
      )
  }
  | sql_a_expr BETWEEN SYMMETRIC sql_b_expr AND sql_a_expr                  %prec BETWEEN   { expr3(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::BETWEEN_SYMMETRIC), $1, $4, $6) }
  | sql_a_expr NOT_LA BETWEEN SYMMETRIC sql_b_expr AND sql_a_expr           %prec NOT_LA    { expr3(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::NOT_BETWEEN_SYMMETRIC), $1, $5, $7) }
  | sql_a_expr IN_P sql_in_expr                                                             { expr2(ctx, @$, enum_node(@2, ExprFunc::IN), $1, $3) }
  | sql_a_expr NOT_LA IN_P sql_in_expr                                      %prec NOT_LA    { expr2(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::NOT_IN), $1, $4) }
  | sql_a_expr sql_subquery_op sql_subquery_quantifier sql_select_with_parens    %prec Op {
      let s = ctx.object(@4, NodeType::OBJECT_SQL_SELECT, $4);
      let e = ctx.object(@$, NodeType::OBJECT_SQL_SELECT_EXPRESSION, &[attr(Key::SQL_SELECT_EXPRESSION_STATEMENT, s)]);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_SUBQUERY_EXPRESSION,
          &[
              attr(Key::SQL_SUBQUERY_ARG0, ctx.expression($1)),
              attr(Key::SQL_SUBQUERY_ARG1, e),
              attr(Key::SQL_SUBQUERY_OPERATOR, $2),
              attr(Key::SQL_SUBQUERY_QUANTIFIER, $3),
          ],
      )
  }
  | sql_a_expr sql_subquery_op sql_subquery_quantifier LRB sql_a_expr RRB        %prec Op {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_SUBQUERY_EXPRESSION,
          &[
              attr(Key::SQL_SUBQUERY_ARG0, ctx.expression($1)),
              attr(Key::SQL_SUBQUERY_ARG1, ctx.expression($5)),
              attr(Key::SQL_SUBQUERY_OPERATOR, $2),
              attr(Key::SQL_SUBQUERY_QUANTIFIER, $3),
          ],
      )
  }
  | DEFAULT { expr0(ctx, @$, enum_node(@1, ExprFunc::DEFAULT)) }
    ;

// Restricted expressions
//
// b_expr is a subset of the complete expression syntax defined by a_expr.
//
// Presently, AND, NOT, IS, and IN are the a_expr keywords that would
// cause trouble in the places where b_expr is used.  For simplicity, we
// just eliminate all the boolean-keyword-operator productions from b_expr.

sql_b_expr:
    sql_c_expr { $1 }
  | sql_b_expr TYPECAST sql_typename {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_TYPECAST_EXPRESSION,
          &[attr(Key::SQL_TYPECAST_VALUE, ctx.expression($1)), attr(Key::SQL_TYPECAST_TYPE, $3)],
      )
  }
  | PLUS sql_b_expr                      %prec UMINUS   { $2 }
  | MINUS sql_b_expr                      %prec UMINUS  { negate(ctx, @$, @1, $2) }
  | sql_b_expr PLUS sql_b_expr      { expr2(ctx, @$, enum_node(@2, ExprFunc::PLUS), $1, $3) }
  | sql_b_expr MINUS sql_b_expr     { expr2(ctx, @$, enum_node(@2, ExprFunc::MINUS), $1, $3) }
  | sql_b_expr STAR sql_b_expr      { expr2(ctx, @$, enum_node(@2, ExprFunc::MULTIPLY), $1, $3) }
  | sql_b_expr DIVIDE sql_b_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::DIVIDE), $1, $3) }
  | sql_b_expr MODULO sql_b_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::MODULUS), $1, $3) }
  | sql_b_expr CIRCUMFLEX sql_b_expr    { expr2(ctx, @$, enum_node(@2, ExprFunc::XOR), $1, $3) }
  | sql_b_expr LESS_THAN sql_b_expr     { expr2(ctx, @$, enum_node(@2, ExprFunc::LESS_THAN), $1, $3) }
  | sql_b_expr GREATER_THAN sql_b_expr  { expr2(ctx, @$, enum_node(@2, ExprFunc::GREATER_THAN), $1, $3) }
  | sql_b_expr EQUALS sql_b_expr        { expr2(ctx, @$, enum_node(@2, ExprFunc::EQUAL), $1, $3) }
  | sql_b_expr LESS_EQUALS sql_b_expr      { expr2(ctx, @$, enum_node(@2, ExprFunc::LESS_EQUAL), $1, $3) }
  | sql_b_expr GREATER_EQUALS sql_b_expr   { expr2(ctx, @$, enum_node(@2, ExprFunc::GREATER_EQUAL), $1, $3) }
  | sql_b_expr NOT_EQUALS sql_b_expr       { expr2(ctx, @$, enum_node(@2, ExprFunc::NOT_EQUAL), $1, $3) }
  | sql_b_expr sql_qual_op sql_b_expr   %prec Op          { expr2(ctx, @$, $2, $1, $3) }
  | sql_qual_op sql_b_expr              %prec Op          { expr1(ctx, @$, $1, $2) }
  | sql_b_expr sql_qual_op              %prec POSTFIXOP   { expr_postfix(ctx, @$, $2, $1) }
  | sql_b_expr IS DISTINCT FROM sql_b_expr          %prec IS    { expr2(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::IS_DISTINCT_FROM), $1, $5) }
  | sql_b_expr IS NOT DISTINCT FROM sql_b_expr      %prec IS    { expr2(ctx, @$, enum_node(loc(&[@2, @3, @4, @5]), ExprFunc::IS_NOT_DISTINCT_FROM), $1, $6) }
  | sql_b_expr IS OF LRB sql_type_list RRB          %prec IS    { expr2(ctx, @$, enum_node(loc(&[@2, @3]), ExprFunc::IS_OF), $1, ctx.array(@5, $5)) }
  | sql_b_expr IS NOT OF LRB sql_type_list RRB      %prec IS    { expr2(ctx, @$, enum_node(loc(&[@2, @3, @4]), ExprFunc::IS_NOT_OF), $1, ctx.array(@6, $6)) }
    ;

// Productions that can be used in both a_expr and b_expr.
//
// Note: productions that refer recursively to a_expr or b_expr mostly
// cannot appear here.    However, it's OK to refer to a_exprs that occur
// inside parentheses, such as function arguments; that cannot introduce
// ambiguity to the b_expr syntax.

sql_param_ref:
  DOLLAR sql_attr_name {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_PARAMETER_REF,
          &[
              attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1)),
              attr(Key::SQL_PARAMETER_NAME, ctx.array(@2, &[$2])),
          ],
      )
  }
  | QUESTION_MARK sql_attr_name {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_PARAMETER_REF,
          &[
              attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1)),
              attr(Key::SQL_PARAMETER_NAME, ctx.array(@2, &[$2])),
          ],
      )
  }
  | DOLLAR ICONST {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_PARAMETER_REF,
          &[
              attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1)),
              attr(Key::SQL_PARAMETER_NAME, ctx.array(@2, &[ctx.name_from_string_literal(@2)])),
          ],
      )
  }
  | QUESTION_MARK ICONST {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_PARAMETER_REF,
          &[
              attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1)),
              attr(Key::SQL_PARAMETER_NAME, ctx.array(@2, &[ctx.name_from_string_literal(@2)])),
          ],
      )
  }
  | PARAM { ctx.object(@$, NodeType::OBJECT_SQL_PARAMETER_REF, &[attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1))]) };

// psql-style :name, :"name" and :'name' parameters.
// Kept out of sql_param_ref so that they cannot follow type and function names in casts,
// which would be ambiguous with array slices such as a[x:y].
sql_colon_param_ref:
    COLON sql_attr_name {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_PARAMETER_REF,
            &[
                attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1)),
                attr(Key::SQL_PARAMETER_NAME, ctx.array(@2, &[$2])),
            ],
        )
    }
  | COLON SCONST {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_PARAMETER_REF,
          &[
              attr(Key::SQL_PARAMETER_PREFIX, operator_node(@1)),
              attr(Key::SQL_PARAMETER_NAME, ctx.array(@2, &[ctx.name_from_string_literal(@2)])),
          ],
      )
  };

sql_c_expr:
    sql_columnref     { $1 }
  | sql_a_expr_const  { $1 }
  | sql_explicit_row  { $1 }
  | sql_implicit_row  { $1 }
  | sql_colon_param_ref { $1 }
  | LRB sql_a_expr RRB sql_opt_indirection {
      if ctx.list_is_empty($4) {
          // Keep boolean chains temporary so an enclosing AND/OR can merge them.
          Value::from($2)
      } else {
          Value::from(ctx.object(
              @$,
              NodeType::OBJECT_SQL_INDIRECTION,
              &[
                  attr(Key::SQL_INDIRECTION_VALUE, ctx.expression($2)),
                  attr(Key::SQL_INDIRECTION_PATH, ctx.array(@4, $4)),
              ],
          ))
      }
  }
  | sql_case_expr                             { $1 }
  | sql_func_expr                             { $1 }
  | sql_select_with_parens      %prec UMINUS  {
      let s = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
      ctx.object(@$, NodeType::OBJECT_SQL_SELECT_EXPRESSION, &[attr(Key::SQL_SELECT_EXPRESSION_STATEMENT, s)])
  }
  | sql_select_with_parens sql_indirection {
      let s = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_SELECT_EXPRESSION,
          &[
              attr(Key::SQL_SELECT_EXPRESSION_STATEMENT, s),
              attr(Key::SQL_SELECT_EXPRESSION_INDIRECTION, ctx.array(@2, $2)),
          ],
      )
  }
  | EXISTS sql_select_with_parens {
      let s = ctx.object(@2, NodeType::OBJECT_SQL_SELECT, $2);
      ctx.object(@$, NodeType::OBJECT_SQL_EXISTS_EXPRESSION, &[attr(Key::SQL_EXISTS_EXPRESSION_STATEMENT, s)])
  }
    ;

sql_func_application:
    sql_func_name LRB RRB { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1))]) }
  | sql_func_name LRB sql_func_arg_list sql_opt_sort_clause RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(@3, $3)),
              attr(Key::SQL_FUNCTION_ORDER, $4),
          ],
      )
  }
  | sql_func_name LRB VARIADIC sql_func_arg_expr sql_opt_sort_clause RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_FUNCTION_VARIADIC, $4),
              attr(Key::SQL_FUNCTION_ORDER, $5),
          ],
      )
  }
  | sql_func_name LRB sql_func_arg_list COMMA VARIADIC sql_func_arg_expr sql_opt_sort_clause RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(@3, $3)),
              attr(Key::SQL_FUNCTION_VARIADIC, $6),
              attr(Key::SQL_FUNCTION_ORDER, $7),
          ],
      )
  }
  | sql_func_name LRB ALL sql_func_arg_list sql_opt_sort_clause RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_FUNCTION_ALL, bool_node(@3, true)),
              attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(@4, $4)),
              attr(Key::SQL_FUNCTION_ORDER, $5),
          ],
      )
  }
  | sql_func_name LRB DISTINCT sql_func_arg_list sql_opt_sort_clause RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_FUNCTION_DISTINCT, bool_node(@3, true)),
              attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(@4, $4)),
              attr(Key::SQL_FUNCTION_ORDER, $5),
          ],
      )
  }
  | sql_func_name LRB STAR RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_FUNCTION_ARGUMENTS_STAR, bool_node(@3, true)),
          ],
      )
  }
    ;


// func_expr and its cousin func_expr_windowless are split out from c_expr just
// so that we have classifications for "everything that is a function call or
// looks like one".  This isn't very important, but it saves us having to
// document which variants are legal in places like "FROM function()" or the
// backwards-compatible functional-index syntax for CREATE INDEX.
// (Note that many of the special SQL functions wouldn't actually make any
// sense as functional index entries, but we ignore that consideration here.)

sql_func_expr:
    sql_func_application sql_within_group_clause sql_filter_clause sql_over_clause {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_FUNCTION_EXPRESSION,
            ctx.concat2(
                $1,
                &[
                    attr(Key::SQL_FUNCTION_WITHIN_GROUP, $2),
                    attr(Key::SQL_FUNCTION_FILTER, $3),
                    attr(Key::SQL_FUNCTION_OVER, $4),
                ],
            ),
        )
    }
  | sql_func_expr_common_subexpr { ctx.object(@$, NodeType::OBJECT_SQL_FUNCTION_EXPRESSION, $1) }
        ;

// As func_expr but does not accept WINDOW functions directly
// (but they can still be contained in arguments for functions etc).
// Use this when window expressions are not allowed, where needed to
// disambiguate the grammar (e.g. in CREATE INDEX).

sql_func_expr_windowless:
    sql_func_application            { ctx.object(@$, NodeType::OBJECT_SQL_FUNCTION_EXPRESSION, $1) }
  | sql_func_expr_common_subexpr    { ctx.object(@$, NodeType::OBJECT_SQL_FUNCTION_EXPRESSION, $1) }
    ;

// Special expressions that are considered to be functions.

sql_func_expr_common_subexpr:
    COLLATION FOR LRB sql_a_expr RRB {
        ctx.list(
            &[
                attr(Key::SQL_FUNCTION_NAME, enum_node(loc(&[@1, @2]), KnownFunction::COLLATION_FOR)),
                attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(loc(&[@1, @2, @3]), &[ctx.expression($4)])),
            ],
        )
    }
  | CURRENT_DATE        { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_DATE))]) }
  | CURRENT_TIME        { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_TIME))]) }
  | CURRENT_TIMESTAMP   { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_TIMESTAMP))]) }
  | LOCALTIME           { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::LOCALTIME))]) }
  | LOCALTIMESTAMP      { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::LOCALTIMESTAMP))]) }
  | CURRENT_TIME LRB ICONST RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(loc(&[@1, @2]), KnownFunction::CURRENT_DATE)),
              attr(
                  Key::SQL_FUNCTION_ARGUMENTS,
                  ctx.array(loc(&[@2, @3, @4]), &[const_node(@3, AConstType::INTEGER)]),
              ),
          ],
      )
  }
  | CURRENT_TIMESTAMP LRB ICONST RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(loc(&[@1, @2]), KnownFunction::CURRENT_TIMESTAMP)),
              attr(
                  Key::SQL_FUNCTION_ARGUMENTS,
                  ctx.array(loc(&[@2, @3, @4]), &[const_node(@3, AConstType::INTEGER)]),
              ),
          ],
      )
  }
  | LOCALTIME LRB ICONST RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(loc(&[@1, @2]), KnownFunction::LOCALTIME)),
              attr(
                  Key::SQL_FUNCTION_ARGUMENTS,
                  ctx.array(loc(&[@2, @3, @4]), &[const_node(@3, AConstType::INTEGER)]),
              ),
          ],
      )
  }
  | LOCALTIMESTAMP LRB ICONST RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(loc(&[@1, @2]), KnownFunction::LOCALTIMESTAMP)),
              attr(
                  Key::SQL_FUNCTION_ARGUMENTS,
                  ctx.array(loc(&[@2, @3, @4]), &[const_node(@3, AConstType::INTEGER)]),
              ),
          ],
      )
  }
  | CURRENT_ROLE    { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_ROLE))]) }
  | CURRENT_USER    { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_USER))]) }
  | SESSION_USER    { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::SESSION_USER))]) }
  | USER            { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::USER))]) }
  | CURRENT_CATALOG { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_CATALOG))]) }
  | CURRENT_SCHEMA  { ctx.list(&[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CURRENT_SCHEMA))]) }
  | CAST LRB sql_a_expr AS sql_typename RRB {
      let args = ctx.object(
          loc(&[@2, @3, @4, @5, @6]),
          NodeType::OBJECT_SQL_FUNCTION_CAST_ARGS,
          &[attr(Key::SQL_FUNCTION_CAST_VALUE, ctx.expression($3)), attr(Key::SQL_FUNCTION_CAST_TYPE, $5)],
      );
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::CAST)),
              attr(Key::SQL_FUNCTION_CAST_ARGS, args),
          ],
      )
  }
  | EXTRACT LRB sql_extract_list RRB {
      let args = ctx.object(loc(&[@2, @3, @4]), NodeType::OBJECT_SQL_FUNCTION_EXTRACT_ARGS, $3);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::EXTRACT)),
              attr(Key::SQL_FUNCTION_EXTRACT_ARGS, args),
          ],
      )
  }
  | OVERLAY LRB sql_overlay_list RRB {
      let args = ctx.object(loc(&[@2, @3, @4]), NodeType::OBJECT_SQL_FUNCTION_OVERLAY_ARGS, $3);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::OVERLAY)),
              attr(Key::SQL_FUNCTION_OVERLAY_ARGS, args),
          ],
      )
  }
  | POSITION LRB sql_position_list RRB {
      let args = ctx.object(loc(&[@2, @3, @4]), NodeType::OBJECT_SQL_FUNCTION_POSITION_ARGS, $3);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::POSITION)),
              attr(Key::SQL_FUNCTION_POSITION_ARGS, args),
          ],
      )
  }
  | SUBSTRING LRB sql_substr_list RRB { ctx.concat2($3, &[attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::SUBSTRING))]) }
  | TRIM LRB BOTH sql_trim_list RRB {
      ctx.push_back($4, attr(Key::SQL_FUNCTION_TRIM_DIRECTION, enum_node(@3, TrimDirection::BOTH)));
      let args = ctx.object(loc(&[@2, @3, @4, @5]), NodeType::OBJECT_SQL_FUNCTION_TRIM_ARGS, $4);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::TRIM)),
              attr(Key::SQL_FUNCTION_TRIM_ARGS, args),
          ],
      )
  }
  | TRIM LRB LEADING sql_trim_list RRB {
      ctx.push_back($4, attr(Key::SQL_FUNCTION_TRIM_DIRECTION, enum_node(@3, TrimDirection::LEADING)));
      let args = ctx.object(loc(&[@2, @3, @4, @5]), NodeType::OBJECT_SQL_FUNCTION_TRIM_ARGS, $4);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::TRIM)),
              attr(Key::SQL_FUNCTION_TRIM_ARGS, args),
          ],
      )
  }
  | TRIM LRB TRAILING sql_trim_list RRB {
      ctx.push_back($4, attr(Key::SQL_FUNCTION_TRIM_DIRECTION, enum_node(@3, TrimDirection::TRAILING)));
      let args = ctx.object(loc(&[@2, @3, @4, @5]), NodeType::OBJECT_SQL_FUNCTION_TRIM_ARGS, $4);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::TRIM)),
              attr(Key::SQL_FUNCTION_TRIM_ARGS, args),
          ],
      )
  }
  | TRIM LRB sql_trim_list RRB {
      let args = ctx.object(loc(&[@2, @3, @4]), NodeType::OBJECT_SQL_FUNCTION_TRIM_ARGS, $3);
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::TRIM)),
              attr(Key::SQL_FUNCTION_TRIM_ARGS, args),
          ],
      )
  }
  | TREAT LRB sql_a_expr AS sql_typename RRB {
      let args = ctx.object(
          loc(&[@2, @3, @4, @5, @6]),
          NodeType::OBJECT_SQL_FUNCTION_TREAT_ARGS,
          &[attr(Key::SQL_FUNCTION_TREAT_VALUE, ctx.expression($3)), attr(Key::SQL_FUNCTION_TREAT_TYPE, $5)],
      );
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::TREAT)),
              attr(Key::SQL_FUNCTION_TREAT_ARGS, args),
          ],
      )
  }
  | NULLIF LRB sql_a_expr COMMA sql_a_expr RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::NULLIF)),
              attr(
                  Key::SQL_FUNCTION_ARGUMENTS,
                  ctx.array(loc(&[@2, @3, @4, @5, @6]), &[ctx.expression($3), ctx.expression($5)]),
              ),
          ],
      )
  }
  | COALESCE LRB sql_expr_list RRB {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_NAME, enum_node(@1, KnownFunction::COALESCE)),
              attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(loc(&[@2, @3, @4]), $3)),
          ],
      )
  }
    ;

// We allow several variants for SQL and other compatibility. */
//
// Aggregate decoration clauses

sql_within_group_clause:
    WITHIN GROUP_P LRB sql_sort_clause RRB  { $4 }
  | %empty                                  { null() }
    ;

sql_filter_clause:
    FILTER LRB WHERE sql_a_expr RRB   { ctx.expression($4) }
  | %empty                            { null() }
    ;


// Window Definitions

sql_window_clause:
    WINDOW sql_window_definition_list   { $2 }
  | %empty                              { ctx.list(NO_NODES) }
    ;

sql_window_definition_list:
    sql_window_definition                                   { ctx.list(&[$1]) }
  | sql_window_definition_list COMMA sql_window_definition    {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_window_definition:
    sql_col_id AS sql_window_specification {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_WINDOW_DEF,
            &[attr(Key::SQL_WINDOW_DEF_NAME, $1), attr(Key::SQL_WINDOW_DEF_FRAME, $3)],
        )
    }
    ;

sql_over_clause:
    OVER sql_window_specification   { $2 }
  | OVER sql_col_id                 { $2 }
  | %empty                          { null() }
    ;

sql_window_specification:
    LRB sql_opt_existing_window_name sql_opt_partition_clause sql_opt_sort_clause sql_opt_frame_clause RRB {
        ctx.object_ex(
            @$,
            NodeType::OBJECT_SQL_WINDOW_FRAME,
            ctx.concat4($2, $3, $5, &[attr(Key::SQL_WINDOW_FRAME_ORDER, $4)]),
            false,
            false,
        )
    }
    ;

// If we see PARTITION, RANGE, ROWS, or GROUPS as the first token after the LRB
// of a window_specification, we want the assumption to be that there is
// no existing_window_name; but those keywords are unreserved and so could
// be ColIds.  We fix this by making them have the same precedence as IDENT
// and giving the empty production here a slightly higher precedence, so
// that the shift/reduce conflict is resolved in favor of reducing the rule.
// These keywords are thus precluded from being an existing_window_name but
// are not reserved for any other purpose.

sql_opt_existing_window_name:
    sql_col_id                  { ctx.list(&[attr(Key::SQL_WINDOW_FRAME_NAME, $1)]) }
  | %empty          %prec Op    { ctx.list(NO_NODES) }
    ;

sql_opt_partition_clause:
    PARTITION BY sql_expr_list  { ctx.list(&[attr(Key::SQL_WINDOW_FRAME_PARTITION, ctx.array(@3, $3))]) }
  | %empty                      { ctx.list(NO_NODES) }
    ;

// For frame clauses, we return a PGWindowDef, but only some fields are used:
// frameOptions, startOffset, and endOffset.
//
// This is only a subset of the full SQL:2008 frame_clause grammar.
// We don't support <window frame exclusion> yet.

sql_opt_frame_clause:
    RANGE sql_frame_extent {
        ctx.list(
            &[
                attr(Key::SQL_WINDOW_FRAME_MODE, enum_node(@1, WindowRangeMode::RANGE)),
                attr(Key::SQL_WINDOW_FRAME_BOUNDS, ctx.array(@2, $2)),
            ],
        )
    }
  | ROWS sql_frame_extent {
      ctx.list(
          &[
              attr(Key::SQL_WINDOW_FRAME_MODE, enum_node(@1, WindowRangeMode::ROWS)),
              attr(Key::SQL_WINDOW_FRAME_BOUNDS, ctx.array(@2, $2)),
          ],
      )
  }
  | GROUPS sql_frame_extent {
      ctx.list(
          &[
              attr(Key::SQL_WINDOW_FRAME_MODE, enum_node(@1, WindowRangeMode::GROUPS)),
              attr(Key::SQL_WINDOW_FRAME_BOUNDS, ctx.array(@2, $2)),
          ],
      )
  }
  | %empty { ctx.list(NO_NODES) }
    ;

sql_frame_extent:
    sql_frame_bound                                 { ctx.list(&[$1]) }
  | BETWEEN sql_frame_bound AND sql_frame_bound     { ctx.list(&[$2, $4]) }
    ;

sql_frame_bound:
    UNBOUNDED PRECEDING {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_WINDOW_BOUND,
            &[
                attr(Key::SQL_WINDOW_BOUND_MODE, enum_node(@1, WindowBoundMode::UNBOUNDED)),
                attr(Key::SQL_WINDOW_BOUND_DIRECTION, enum_node(@1, WindowBoundDirection::PRECEDING)),
            ],
        )
    }
  | UNBOUNDED FOLLOWING {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_WINDOW_BOUND,
          &[
              attr(Key::SQL_WINDOW_BOUND_MODE, enum_node(@1, WindowBoundMode::UNBOUNDED)),
              attr(Key::SQL_WINDOW_BOUND_DIRECTION, enum_node(@1, WindowBoundDirection::FOLLOWING)),
          ],
      )
  }
  | CURRENT_P ROW {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_WINDOW_BOUND,
          &[attr(Key::SQL_WINDOW_BOUND_MODE, enum_node(@1, WindowBoundMode::CURRENT_ROW))],
      )
  }
  | sql_a_expr PRECEDING {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_WINDOW_BOUND,
          &[
              attr(Key::SQL_WINDOW_BOUND_MODE, enum_node(@1, WindowBoundMode::VALUE)),
              attr(Key::SQL_WINDOW_BOUND_DIRECTION, enum_node(@1, WindowBoundDirection::PRECEDING)),
              attr(Key::SQL_WINDOW_BOUND_VALUE, ctx.expression($1)),
          ],
      )
  }
  | sql_a_expr FOLLOWING {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_WINDOW_BOUND,
          &[
              attr(Key::SQL_WINDOW_BOUND_MODE, enum_node(@1, WindowBoundMode::VALUE)),
              attr(Key::SQL_WINDOW_BOUND_DIRECTION, enum_node(@1, WindowBoundDirection::FOLLOWING)),
              attr(Key::SQL_WINDOW_BOUND_VALUE, ctx.expression($1)),
          ],
      )
  }
    ;


// Supporting nonterminals for expressions.

// Explicit row production.
//
// SQL99 allows an optional ROW keyword, so we can now do single-element rows
// without conflicting with the parenthesized a_expr production.  Without the
// ROW keyword, there must be more than one a_expr inside the parens.

sql_row:
    sql_explicit_row    { $1 }
  | sql_implicit_row    { $1 }
    ;

sql_explicit_row:
    ROW LRB sql_expr_list RRB {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ROW_EXPRESSION,
            &[
                attr(Key::SQL_ROW_EXPRESSION_EXPLICIT, bool_node(@1, true)),
                attr(Key::SQL_ROW_EXPRESSION_VALUES, ctx.array(@3, $3)),
            ],
        )
    }
  | ROW LRB RRB {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_ROW_EXPRESSION,
          &[
              attr(Key::SQL_ROW_EXPRESSION_EXPLICIT, bool_node(@1, true)),
              attr(Key::SQL_ROW_EXPRESSION_VALUES, ctx.array_ex(loc(&[@2, @3]), ctx.list(NO_NODES), false, false)),
          ],
      )
  }
    ;

sql_implicit_row:
    LRB sql_expr_list COMMA sql_a_expr RRB {
        ctx.push_back($2, ctx.expression($4));
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_ROW_EXPRESSION,
            &[attr(Key::SQL_ROW_EXPRESSION_VALUES, ctx.array(loc(&[@2, @3, @4]), $2))],
        )
    }
    ;

sql_subquery_quantifier:
    ANY             { enum_node(@1, SubqueryQuantifier::ANY) }
  | SOME            { enum_node(@1, SubqueryQuantifier::SOME) }
  | ALL             { enum_node(@1, SubqueryQuantifier::ALL) }
    ;

sql_all_op:
    Op              { operator_node(@1) }
  | AMPERSAND       { operator_node(@1) }
  | PIPE            { operator_node(@1) }
  | EXCLAMATION_MARK { operator_node(@1) }
  | sql_math_op     { $1 }
    ;

sql_math_op:
    PLUS            { enum_node(@1, ExpressionOperator::PLUS) }
  | MINUS           { enum_node(@1, ExpressionOperator::MINUS) }
  | STAR            { enum_node(@1, ExpressionOperator::MULTIPLY) }
  | DIVIDE          { enum_node(@1, ExpressionOperator::DIVIDE) }
  | MODULO          { enum_node(@1, ExpressionOperator::MODULUS) }
  | CIRCUMFLEX      { enum_node(@1, ExpressionOperator::XOR) }
  | LESS_THAN       { enum_node(@1, ExpressionOperator::LESS_THAN) }
  | GREATER_THAN    { enum_node(@1, ExpressionOperator::GREATER_THAN) }
  | EQUALS          { enum_node(@1, ExpressionOperator::EQUAL) }
  | LESS_EQUALS     { enum_node(@1, ExpressionOperator::LESS_EQUAL) }
  | GREATER_EQUALS  { enum_node(@1, ExpressionOperator::GREATER_EQUAL) }
  | NOT_EQUALS      { enum_node(@1, ExpressionOperator::NOT_EQUAL) }
    ; 

sql_qual_op:
    Op                                  { operator_node(@1) }
  | AMPERSAND                           { operator_node(@1) }
  | PIPE                                { operator_node(@1) }
  | EXCLAMATION_MARK                    { operator_node(@1) }
  | OPERATOR LRB sql_any_operator RRB   { ctx.array(@$, $3) } // XXX Make object
    ;

sql_qual_all_op:
    sql_all_op                          { $1 }
  | OPERATOR LRB sql_any_operator RRB   { ctx.array(@$, $3) } // XXX Make object
    ;

// cannot put SIMILAR TO into sql_subquery_op, because SIMILAR TO is a hack.
// the regular expression is preprocessed by a function (similar_escape),
// and the ~ operator for posix regular expressions is used.
//        x SIMILAR TO y     ->    x ~ similar_escape(y)
// this transformation is made on the fly by the parser upwards.
// however the PGSubLink structure which handles any/some/all stuff
// is not ready for such a thing.

sql_subquery_op:
    sql_all_op      { $1 }
  | LIKE            { enum_node(@1, ExpressionOperator::LIKE) }
  | NOT_LA LIKE     { enum_node(@1, ExpressionOperator::NOT_LIKE) }
  | GLOB            { enum_node(@1, ExpressionOperator::GLOB) }
  | NOT_LA GLOB     { enum_node(@1, ExpressionOperator::NOT_GLOB) }
  | ILIKE           { enum_node(@1, ExpressionOperator::ILIKE) }
  | NOT_LA ILIKE    { enum_node(@1, ExpressionOperator::NOT_ILIKE) }
  | OPERATOR LRB sql_any_operator RRB   { ctx.array(@$, $3) }
    ;

sql_any_operator:
    sql_all_op                        { ctx.list(&[$1]) }
  | sql_col_id DOT sql_any_operator   {
      ctx.push_front($3, $1);
      $3
  }
    ;

sql_expr_list:
    sql_a_expr                      { ctx.list(&[ctx.expression($1)]) }
  | sql_expr_list COMMA sql_a_expr  {
      ctx.push_back($1, ctx.expression($3));
      $1
  }
    ;

sql_func_arg_list:
    sql_func_arg_expr                           { ctx.list(&[$1]) }
  | sql_func_arg_list COMMA sql_func_arg_expr     {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_func_arg_expr:
    sql_a_expr {
        ctx.object(@$, NodeType::OBJECT_SQL_FUNCTION_ARG, &[attr(Key::SQL_FUNCTION_ARG_VALUE, ctx.expression($1))])
    }
  | sql_descriptor_arg { ctx.object(@$, NodeType::OBJECT_SQL_FUNCTION_ARG, &[attr(Key::SQL_FUNCTION_ARG_VALUE, $1)]) }
  | sql_relation_arg { ctx.object(@$, NodeType::OBJECT_SQL_FUNCTION_ARG, &[attr(Key::SQL_FUNCTION_ARG_VALUE, $1)]) }
  | sql_param_name COLON_EQUALS sql_a_expr {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_ARG,
          &[attr(Key::SQL_FUNCTION_ARG_NAME, $1), attr(Key::SQL_FUNCTION_ARG_VALUE, ctx.expression($3))],
      )
  }
  | sql_param_name COLON_EQUALS sql_descriptor_arg {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_ARG,
          &[attr(Key::SQL_FUNCTION_ARG_NAME, $1), attr(Key::SQL_FUNCTION_ARG_VALUE, $3)],
      )
  }
  | sql_param_name COLON_EQUALS sql_relation_arg {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_ARG,
          &[attr(Key::SQL_FUNCTION_ARG_NAME, $1), attr(Key::SQL_FUNCTION_ARG_VALUE, $3)],
      )
  }
  | sql_param_name EQUALS_GREATER sql_a_expr {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_ARG,
          &[attr(Key::SQL_FUNCTION_ARG_NAME, $1), attr(Key::SQL_FUNCTION_ARG_VALUE, ctx.expression($3))],
      )
  }
  | sql_param_name EQUALS_GREATER sql_descriptor_arg {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_ARG,
          &[attr(Key::SQL_FUNCTION_ARG_NAME, $1), attr(Key::SQL_FUNCTION_ARG_VALUE, $3)],
      )
  }
  | sql_param_name EQUALS_GREATER sql_relation_arg {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_ARG,
          &[attr(Key::SQL_FUNCTION_ARG_NAME, $1), attr(Key::SQL_FUNCTION_ARG_VALUE, $3)],
      )
  }
    ;

sql_relation_arg:
    TABLE LRB sql_qualified_name RRB { ctx.object(@$, NodeType::OBJECT_SQL_RELATION_EXPR, &[attr(Key::SQL_TABLEREF_NAME, $3)]) }
    ;

sql_descriptor_arg:
    DESCRIPTOR LRB sql_table_func_element_list RRB { ctx.object(@$, NodeType::OBJECT_SQL_DESCRIPTOR, &[attr(Key::SQL_DESCRIPTOR_COLUMNS, ctx.array(@3, $3))]) }
    ;

sql_type_list:
    sql_typename                        { ctx.list(&[$1]) }
  | sql_type_list COMMA sql_typename    {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_extract_list:
    sql_extract_arg FROM sql_a_expr {
        ctx.list(
            &[
                attr(Key::SQL_FUNCTION_EXTRACT_TARGET, $1),
                attr(Key::SQL_FUNCTION_EXTRACT_INPUT, ctx.expression($3)),
            ],
        )
    }
  | %empty  { ctx.list(NO_NODES) }
    ;

// Allow delimited string Sconst in extract_arg as an SQL extension.
// - thomas 2001-04-12
sql_extract_arg:
    IDENT       { name_from_identifier(@1, $1) }
  | YEAR_P      { enum_node(@1, ExtractTarget::YEAR) }
  | MONTH_P     { enum_node(@1, ExtractTarget::MONTH) }
  | DAY_P       { enum_node(@1, ExtractTarget::DAY) }
  | HOUR_P      { enum_node(@1, ExtractTarget::HOUR) }
  | MINUTE_P    { enum_node(@1, ExtractTarget::MINUTE) }
  | SECOND_P    { enum_node(@1, ExtractTarget::SECOND) }
  | SCONST      { const_node(@1, AConstType::STRING) }
    ;

// OVERLAY() arguments
// SQL99 defines the OVERLAY() function:
//  - overlay(text placing text from int for int)
//  - overlay(text placing text from int)
// and similarly for binary strings

sql_overlay_list:
    sql_a_expr sql_overlay_placing sql_substr_from sql_substr_for {
        ctx.list(
            &[
                attr(Key::SQL_FUNCTION_OVERLAY_INPUT, ctx.expression($1)),
                attr(Key::SQL_FUNCTION_OVERLAY_PLACING, $2),
                attr(Key::SQL_FUNCTION_OVERLAY_FROM, $3),
                attr(Key::SQL_FUNCTION_OVERLAY_FOR, $4),
            ],
        )
    }
  | sql_a_expr sql_overlay_placing sql_substr_from {
      ctx.list(
          &[
              attr(Key::SQL_FUNCTION_OVERLAY_INPUT, ctx.expression($1)),
              attr(Key::SQL_FUNCTION_OVERLAY_PLACING, $2),
              attr(Key::SQL_FUNCTION_OVERLAY_FROM, $3),
          ],
      )
  }
    ;

sql_overlay_placing:
    PLACING sql_a_expr { ctx.expression($2) }
    ;

// position_list uses b_expr not a_expr to avoid conflict with general IN

sql_position_list:
    sql_b_expr IN_P sql_b_expr {
        ctx.list(
            &[
                attr(Key::SQL_FUNCTION_POSITION_SEARCH, ctx.expression($1)),
                attr(Key::SQL_FUNCTION_POSITION_INPUT, ctx.expression($3)),
            ],
        )
    }
  | %empty { ctx.list(NO_NODES) }
    ;

// SUBSTRING() arguments
// SQL9x defines a specific syntax for arguments to SUBSTRING():
//  - substring(text from int for int)
//  - substring(text from int) get entire string from starting point "int"
//  - substring(text for int) get first "int" characters of string
//  - substring(text from pattern) get entire string matching pattern
//  - substring(text from pattern for escape) same with specified escape char
// We also want to support generic substring functions which accept
// the usual generic list of arguments. So we will accept both styles
// here, and convert the SQL9x style to the generic list for further
// processing. - thomas 2000-11-28

sql_substr_list:
    sql_a_expr sql_substr_from sql_substr_for {
        let args = ctx.object(
            @$,
            NodeType::OBJECT_SQL_FUNCTION_SUBSTRING_ARGS,
            &[
                attr(Key::SQL_FUNCTION_SUBSTRING_INPUT, ctx.expression($1)),
                attr(Key::SQL_FUNCTION_SUBSTRING_FROM, $2),
                attr(Key::SQL_FUNCTION_SUBSTRING_FOR, $3),
            ],
        );
        ctx.list(&[attr(Key::SQL_FUNCTION_SUBSTRING_ARGS, args)])
    }
  | sql_a_expr sql_substr_for sql_substr_from {
      let args = ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_SUBSTRING_ARGS,
          &[
              attr(Key::SQL_FUNCTION_SUBSTRING_INPUT, ctx.expression($1)),
              attr(Key::SQL_FUNCTION_SUBSTRING_FOR, $2),
              attr(Key::SQL_FUNCTION_SUBSTRING_FROM, $3),
          ],
      );
      ctx.list(&[attr(Key::SQL_FUNCTION_SUBSTRING_ARGS, args)])
  }
  | sql_a_expr sql_substr_from {
      let args = ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_SUBSTRING_ARGS,
          &[
              attr(Key::SQL_FUNCTION_SUBSTRING_INPUT, ctx.expression($1)),
              attr(Key::SQL_FUNCTION_SUBSTRING_FROM, $2),
          ],
      );
      ctx.list(&[attr(Key::SQL_FUNCTION_SUBSTRING_ARGS, args)])
  }
  | sql_a_expr sql_substr_for {
      let args = ctx.object(
          @$,
          NodeType::OBJECT_SQL_FUNCTION_SUBSTRING_ARGS,
          &[
              attr(Key::SQL_FUNCTION_SUBSTRING_INPUT, ctx.expression($1)),
              attr(Key::SQL_FUNCTION_SUBSTRING_FOR, $2),
          ],
      );
      ctx.list(&[attr(Key::SQL_FUNCTION_SUBSTRING_ARGS, args)])
  }
  | sql_expr_list   { ctx.list(&[attr(Key::SQL_FUNCTION_ARGUMENTS, ctx.array(@1, $1))]) }
  | %empty          { ctx.list(NO_NODES) }
    ;

sql_substr_from:
    FROM sql_a_expr   { ctx.expression($2) }
    ;

sql_substr_for:
    FOR sql_a_expr    { ctx.expression($2) }
    ;

sql_trim_list:
    sql_a_expr FROM sql_expr_list {
        ctx.list(
            &[
                attr(Key::SQL_FUNCTION_TRIM_CHARACTERS, ctx.expression($1)),
                attr(Key::SQL_FUNCTION_TRIM_INPUT, ctx.array(loc(&[@2, @3]), $3)),
            ],
        )
    }
  | FROM sql_expr_list  { ctx.list(&[attr(Key::SQL_FUNCTION_TRIM_INPUT, ctx.array(loc(&[@1, @2]), $2))]) }
  | sql_expr_list       { ctx.list(&[attr(Key::SQL_FUNCTION_TRIM_INPUT, ctx.array(@$, $1))]) }
    ;

sql_in_expr:
    sql_select_with_parens  {
        let s = ctx.object(@1, NodeType::OBJECT_SQL_SELECT, $1);
        ctx.object(@$, NodeType::OBJECT_SQL_SELECT_EXPRESSION, &[attr(Key::SQL_SELECT_EXPRESSION_STATEMENT, s)])
    }
  | LRB sql_expr_list RRB { ctx.array(@$, $2) }
    ;

// Define SQL-style CASE clause.
//  - Full specification
//    CASE WHEN a = b THEN c ... ELSE d END
//  - Implicit argument
//    CASE a WHEN b THEN c ... ELSE d END

sql_case_expr:
    CASE sql_case_arg sql_when_clause_list sql_case_default END_P {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_CASE,
            &[
                attr(Key::SQL_CASE_ARGUMENT, $2),
                attr(Key::SQL_CASE_CLAUSES, ctx.array(@3, $3)),
                attr(Key::SQL_CASE_DEFAULT, $4),
            ],
        )
    }
    ;

sql_when_clause_list:
    // There must be at least one
    sql_when_clause                       { ctx.list(&[$1]) }
  | sql_when_clause_list sql_when_clause  {
      ctx.push_back($1, $2);
      $1
  }
    ;

sql_when_clause:
    WHEN sql_a_expr THEN sql_a_expr {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_CASE_CLAUSE,
            &[
                attr(Key::SQL_CASE_CLAUSE_WHEN, ctx.expression($2)),
                attr(Key::SQL_CASE_CLAUSE_THEN, ctx.expression($4)),
            ],
        )
    }
    ;

sql_case_default:
    ELSE sql_a_expr   { ctx.expression($2) }
  | %empty            { null() }
    ;

sql_case_arg:
    sql_a_expr        { ctx.expression($1) }
  | %empty            { null() }
    ;

sql_columnref:
    sql_col_id                  { column_ref(ctx, @$, ctx.list(&[$1])) }
  | sql_col_id sql_indirection  {
      ctx.push_front($2, $1);
      column_ref(ctx, @$, $2)
  }
    ;

ext_dot_trailing: DOT_TRAILING | DOT EOF

sql_indirection_el:
    DOT sql_attr_name       { $2 }
  | ext_dot_trailing        { ctx.trailing_dot(@$) }
  | LSB sql_a_expr RSB      { indirection_index(ctx, @$, ctx.expression($2)) }
  | LSB sql_opt_slice_bound COLON sql_opt_slice_bound RSB     { indirection_index_bounds(ctx, @$, $2, $4) }
    ;

sql_opt_slice_bound:
    sql_a_expr              { ctx.expression($1) }
  | %empty %prec SLICE_EMPTY_BOUND { null() }
    ;

sql_indirection:
    sql_indirection_el                      { ctx.list(&[$1]) }
  | sql_indirection sql_indirection_el      {
      ctx.push_back($1, $2);
      $1
  }
    ;

sql_opt_indirection:
    %empty                                  { ctx.list(NO_NODES) }
  | sql_opt_indirection sql_indirection_el  {
      ctx.push_back($1, $2);
      $1
  }
    ;

sql_opt_asymmetric:
    ASYMMETRIC      { true }
  | %empty          { false }
    ;


// ---------------------------------------------------------------------------
// Target list for SELECT

sql_opt_target_list:
    sql_target_list   { $1 }
  | %empty            { ctx.list(NO_NODES) }
    ;

sql_target_list:
    sql_target_el                           { ctx.list(&[$1]) }
  | sql_target_list COMMA sql_target_el     {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_target_el:
    sql_a_expr AS sql_col_label_or_string {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_RESULT_TARGET,
            &[attr(Key::SQL_RESULT_TARGET_VALUE, ctx.expression($1)), attr(Key::SQL_RESULT_TARGET_NAME, $3)],
        )
    }

    // We support omitting AS only for column labels that aren't
    // any known keyword.  There is an ambiguity against postfix
    // operators: is "a ! b" an infix expression, or a postfix
    // expression and a column label?  We prefer to resolve this
    // as an infix expression, which we accomplish by assigning
    // IDENT a precedence higher than POSTFIXOP.

  | sql_a_expr IDENT {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_RESULT_TARGET,
          &[
              attr(Key::SQL_RESULT_TARGET_VALUE, ctx.expression($1)),
              attr(Key::SQL_RESULT_TARGET_NAME, name_from_identifier(@2, $2)),
          ],
      )
  }
  | sql_a_expr  {
      ctx.object(@$, NodeType::OBJECT_SQL_RESULT_TARGET, &[attr(Key::SQL_RESULT_TARGET_VALUE, ctx.expression($1))])
  }
  | STAR {
      ctx.object(@$, NodeType::OBJECT_SQL_RESULT_TARGET, &[attr(Key::SQL_RESULT_TARGET_STAR, bool_node(@1, true))])
  }
  | sql_columnref DOT_STAR_LA STAR {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_RESULT_TARGET,
          &[attr(Key::SQL_RESULT_TARGET_STAR, bool_node(@3, true)), attr(Key::SQL_RESULT_TARGET_VALUE, $1)],
      )
  }
    ;


// ---------------------------------------------------------------------------
// Names and constants

sql_qualified_name_list:
    sql_qualified_name                                  { ctx.list(&[$1]) }
  | sql_qualified_name_list COMMA sql_qualified_name    {
      ctx.push_back($1, $3);
      $1
  }
    ;

// The production for a qualified relation name has to exactly match the
// production for a qualified func_name, because in a FROM clause we cannot
// tell which we are parsing until we see what comes after it (LRB for a
// func_name, something else for a relation). Therefore we allow 'indirection'
// which may contain subscripts, and reject that case in the C code.

sql_qualified_name:
    sql_col_id                      { ctx.array(@$, &[$1]) };
  | sql_col_id sql_indirection      {
      ctx.push_front($2, $1);
      ctx.array(@$, $2)
  };
    ;

sql_name_list:
    sql_name                        {
        let yyval = ctx.list(NO_NODES);
        ctx.push_back(yyval, $1);
        yyval
    }
  | sql_name_list COMMA sql_name      {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_name: sql_col_id            { $1 };
sql_attr_name: sql_col_label    { $1 };

// The production for a qualified func_name has to exactly match the
// production for a qualified columnref, because we cannot tell which we
// are parsing until we see what comes after it (LRB or Sconst for a func_name,
// anything else for a columnref).  Therefore we allow 'indirection' which
// may contain subscripts, and reject that case in the C code.  (If we
// ever implement SQL99-like methods, such syntax may actually become legal!)

sql_func_name:
    sql_type_function_name      { ctx.list(&[$1]) }
  | sql_col_id sql_indirection  {
      ctx.push_front($2, $1);
      $2
  }
    ;

// Constants
sql_a_expr_const:
    ICONST  { const_node(@1, AConstType::INTEGER) }
  | FCONST  { const_node(@1, AConstType::FLOAT) }
  | SCONST  { const_node(@1, AConstType::STRING) }
  | BCONST  { const_node(@1, AConstType::STRING) }
  | XCONST  { const_node(@1, AConstType::STRING) }
  | sql_param_ref { $1 }
  | sql_const_typename SCONST {
      let t = ctx.object(@$, NodeType::OBJECT_SQL_TYPENAME, &[attr(Key::SQL_TYPENAME_TYPE, $1)]);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_TYPE_CAST,
          &[
              attr(Key::SQL_CONST_CAST_TYPE, t),
              attr(Key::SQL_CONST_CAST_VALUE, const_node(@2, AConstType::STRING)),
          ],
      )
  }
  | sql_const_typename sql_param_ref {
      let t = ctx.object(@$, NodeType::OBJECT_SQL_TYPENAME, &[attr(Key::SQL_TYPENAME_TYPE, $1)]);
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_TYPE_CAST,
          &[attr(Key::SQL_CONST_CAST_TYPE, t), attr(Key::SQL_CONST_CAST_VALUE, $2)],
      )
  }
  | sql_func_name SCONST {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_FUNCTION_CAST,
          &[
              attr(Key::SQL_CONST_CAST_FUNC_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_CONST_CAST_VALUE, const_node(@2, AConstType::STRING)),
          ],
      )
  }
  | sql_func_name sql_param_ref {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_FUNCTION_CAST,
          &[attr(Key::SQL_CONST_CAST_FUNC_NAME, ctx.array(@1, $1)), attr(Key::SQL_CONST_CAST_VALUE, $2)],
      )
  }
  | sql_func_name LRB sql_func_arg_list sql_opt_sort_clause RRB SCONST {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_FUNCTION_CAST,
          &[
              attr(Key::SQL_CONST_CAST_FUNC_NAME, ctx.array(@1, $1)),
              attr(Key::SQL_CONST_CAST_FUNC_ARGS_LIST, ctx.array(@3, $3)),
              attr(Key::SQL_CONST_CAST_FUNC_ARGS_ORDER, $4),
              attr(Key::SQL_CONST_CAST_VALUE, const_node(@6, AConstType::STRING)),
          ],
      )
  }
  | sql_const_interval LRB sql_a_expr RRB SCONST {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_INTERVAL_CAST,
          &[
              attr(Key::SQL_CONST_CAST_VALUE, const_node(@5, AConstType::STRING)),
              attr(Key::SQL_CONST_CAST_INTERVAL, ctx.expression($3)),
          ],
      )
  }
  | sql_const_interval sql_param_ref sql_opt_interval {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_INTERVAL_CAST,
          &[attr(Key::SQL_CONST_CAST_VALUE, $2), attr(Key::SQL_CONST_CAST_INTERVAL, $3)],
      )
  }
  | sql_const_interval SCONST sql_opt_interval {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_INTERVAL_CAST,
          &[
              attr(Key::SQL_CONST_CAST_VALUE, const_node(@2, AConstType::STRING)),
              attr(Key::SQL_CONST_CAST_INTERVAL, $3),
          ],
      )
  }
  | sql_const_interval ICONST sql_opt_interval {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CONST_INTERVAL_CAST,
          &[
              attr(Key::SQL_CONST_CAST_VALUE, const_node(@2, AConstType::INTEGER)),
              attr(Key::SQL_CONST_CAST_INTERVAL, $3),
          ],
      )
  }
  | TRUE_P    { bool_node(@1, true) }
  | FALSE_P   { bool_node(@1, false) }
  | NULL_P    { const_node(@1, AConstType::NULL_) }
    ;

// Name classification hierarchy.
//
// IDENT is the lexeme returned by the lexer for identifiers that match
// no known keyword.  In most cases, we can accept certain keywords as
// names, not only IDENTs.    We prefer to accept as many such keywords
// as possible to minimize the impact of "reserved words" on programmers.
// So, we divide names into several possible classes.  The classification
// is chosen in part to make keywords acceptable as names wherever possible.

// Column identifier --- names that can be column, table, etc names.

sql_col_id:
    IDENT                       { name_from_identifier(@1, $1) }
  | sql_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
  | sql_column_name_keywords    { ctx.name_from_keyword(@1, $1) }
  | vis_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
    ;

sql_col_id_or_string:
    sql_col_id                  { $1 }
  | SCONST                      { ctx.name_from_string_literal(@1) }
    ;

// Type/function identifier --- names that can be type or function names.

sql_type_function_name:
    IDENT                       { name_from_identifier(@1, $1) }
  | sql_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
  | GROUPING                    { ctx.name_from_keyword(@1, "grouping") }
  | sql_type_func_keywords      { ctx.name_from_keyword(@1, $1) }
  | vis_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
    ;

sql_any_name:
    sql_col_id                  { ctx.list(&[$1]) }
  | sql_col_id sql_attrs        {
      ctx.push_front($2, $1);
      $2
  }
    ;

sql_attrs:
    ext_dot_trailing                { ctx.list(&[ctx.trailing_dot(@$)]) }
  | DOT sql_attr_name               { ctx.list(&[$2]) }
  | sql_attrs DOT sql_attr_name     {
      ctx.push_back($1, $3);
      $1
  }
  | sql_attrs ext_dot_trailing      {
      ctx.push_back($1, ctx.trailing_dot(@$));
      $1
  }
    ;

sql_param_name:
    sql_type_function_name      { $1 }
    ;

// Any not-fully-reserved word --- these names can be, eg, role names.

// Column label --- allowed labels in "AS" clauses.
// This presently includes *all* Postgres keywords.

sql_col_label:
    IDENT                       { name_from_identifier(@1, $1) }
  | sql_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
  | sql_column_name_keywords    { ctx.name_from_keyword(@1, $1) }
  | sql_type_func_keywords      { ctx.name_from_keyword(@1, $1) }
  | sql_reserved_keywords       { ctx.name_from_keyword(@1, $1) }
  | vis_unreserved_keywords     { ctx.name_from_keyword(@1, $1) }
    ;

sql_col_label_or_string:
    sql_col_label               { $1 }
  | SCONST                      { ctx.name_from_string_literal(@1) }
    ;
