sql_create_as_stmt:
    CREATE_P sql_opt_temp TABLE sql_create_as_target AS sql_select_stmt sql_opt_with_data {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_CREATE_AS,
            ctx.concat2(
                $4,
                &[
                    attr(Key::SQL_CREATE_AS_TEMP, $2),
                    attr(Key::SQL_CREATE_AS_STATEMENT, ctx.object(@6, NodeType::OBJECT_SQL_SELECT, $6)),
                    attr(Key::SQL_CREATE_AS_WITH_DATA, $7),
                ],
            ),
        )
    }
  | CREATE_P sql_opt_temp TABLE IF_P NOT EXISTS sql_create_as_target AS sql_select_stmt sql_opt_with_data {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CREATE_AS,
          ctx.concat2(
              $7,
              &[
                  attr(Key::SQL_CREATE_AS_IF_NOT_EXISTS, bool_node(loc(&[@4, @5, @6]), true)),
                  attr(Key::SQL_CREATE_AS_TEMP, $2),
                  attr(Key::SQL_CREATE_AS_STATEMENT, ctx.object(@9, NodeType::OBJECT_SQL_SELECT, $9)),
                  attr(Key::SQL_CREATE_AS_WITH_DATA, $10),
              ],
          ),
      )
  }
    ;

sql_create_as_target:
    sql_qualified_name sql_opt_column_list sql_opt_with sql_on_commit_option {
        ctx.list(
            &[
                attr(Key::SQL_CREATE_AS_NAME, $1),
                attr(Key::SQL_CREATE_AS_COLUMNS, ctx.array(@2, $2)),
                attr(Key::SQL_CREATE_AS_ON_COMMIT, $4),
            ],
        )
    }
    ;
    
sql_create_stmt:
    CREATE_P sql_opt_temp TABLE sql_qualified_name LRB sql_opt_table_element_list RRB sql_on_commit_option {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_CREATE,
            &[
                attr(Key::SQL_CREATE_TABLE_TEMP, $2),
                attr(Key::SQL_CREATE_TABLE_NAME, $4),
                attr(Key::SQL_CREATE_TABLE_ELEMENTS, ctx.array(loc(&[@5, @6, @7]), $6)),
                attr(Key::SQL_CREATE_TABLE_ON_COMMIT, $8),
            ],
        )
    }
  | CREATE_P sql_opt_temp TABLE IF_P NOT EXISTS sql_qualified_name LRB sql_opt_table_element_list RRB sql_on_commit_option {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_CREATE,
          &[
              attr(Key::SQL_CREATE_TABLE_TEMP, $2),
              attr(Key::SQL_CREATE_TABLE_IF_NOT_EXISTS, bool_node(loc(&[@4, @5, @6]), true)),
              attr(Key::SQL_CREATE_TABLE_NAME, $7),
              attr(Key::SQL_CREATE_TABLE_ELEMENTS, ctx.array(loc(&[@8, @9, @10]), $9)),
              attr(Key::SQL_CREATE_TABLE_ON_COMMIT, $11),
          ],
      )
  }
    ;

sql_opt_table_element_list:
    sql_table_element_list  { $1 }
  | %empty                  { ctx.list(NO_NODES) }
    ;

sql_table_element_list:
    sql_table_element                             { ctx.list(&[$1]) }
  | sql_table_element_list COMMA sql_table_element  {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_table_element:
    sql_column_def        { $1 }
  | sql_table_constraint  { $1 }
    ;

sql_column_def:
    sql_col_id sql_typename sql_create_generic_options sql_col_qual_list {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_COLUMN_DEF,
            &[
                attr(Key::SQL_COLUMN_DEF_NAME, $1),
                attr(Key::SQL_COLUMN_DEF_TYPE, $2),
                attr(Key::SQL_COLUMN_DEF_OPTIONS, $3),
                attr(Key::SQL_COLUMN_DEF_CONSTRAINTS, ctx.array(@4, $4)),
            ],
        )
    }
    ;

sql_col_qual_list:
    sql_col_qual_list sql_col_constraint    {
        ctx.push_back($1, $2);
        $1
    }
  | %empty                                  { ctx.list(NO_NODES) }
    ;

sql_col_constraint:
    CONSTRAINT sql_name sql_col_constraint_elem {
        ctx.push_back($3, attr(Key::SQL_COLUMN_CONSTRAINT_NAME, $2));
        ctx.object(@$, NodeType::OBJECT_SQL_COLUMN_CONSTRAINT, $3)
    }
  | sql_col_constraint_elem { ctx.object(@$, NodeType::OBJECT_SQL_COLUMN_CONSTRAINT, $1) }
  | sql_col_constraint_attr { $1 }
  | COLLATE sql_any_name    {
      ctx.object(
          @$,
          NodeType::OBJECT_SQL_COLUMN_CONSTRAINT,
          &[
              attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::COLLATE)),
              attr(Key::SQL_COLUMN_CONSTRAINT_COLLATE, ctx.array(@2, $2)),
          ],
      )
  }
    ;

sql_col_constraint_attr:
    DEFERRABLE              { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
  | NOT DEFERRABLE          { enum_node(@$, ConstraintAttribute::NOT_DEFERRABLE) }
  | INITIALLY DEFERRED      { enum_node(@$, ConstraintAttribute::INITIALLY_DEFERRED) }
  | INITIALLY IMMEDIATE     { enum_node(@$, ConstraintAttribute::INITIALLY_IMMEDIATE) }
    ;

sql_opt_definition:
    WITH sql_definition     { $2 }
  | %empty                  { ctx.list(NO_NODES) }
    ;

sql_definition: LRB sql_def_list RRB { $2 }

sql_def_list: 
    sql_def_elem                    { ctx.list(&[$1]) }
  | sql_def_list COMMA sql_def_elem   {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_def_elem:
    sql_col_label EQUALS sql_def_arg {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_DEF_ARG,
            &[attr(Key::SQL_DEFINITION_ARG_KEY, $1), attr(Key::SQL_DEFINITION_ARG_VALUE, $3)],
        )
    }
    ;

sql_def_arg:
    sql_func_type           { $1 }
  | sql_reserved_keywords   { ctx.name_from_keyword(@1, $1) }
  | sql_qual_all_op         { $1 }
  | sql_numeric_only        { $1 }
  | SCONST                  { const_node(@1, AConstType::STRING) }
  | NONE                    { null() }
    ;

sql_numeric_only:
    FCONST              { const_node(@$, AConstType::FLOAT) }
  | PLUS FCONST          { const_node(@$, AConstType::FLOAT) }
  | MINUS FCONST          { const_node(@$, AConstType::FLOAT) }
  | sql_signed_iconst   { $1 }
    ;

sql_signed_iconst:
    ICONST      { const_node(@$, AConstType::INTEGER) }
  | PLUS ICONST  { const_node(@$, AConstType::INTEGER) }
  | MINUS ICONST  { const_node(@$, AConstType::INTEGER) }
    ;

// XXX omitted SETOF
sql_func_type:
    sql_typename { $1 }
    ;

// XXX omitted identity and foreign
sql_col_constraint_elem:
    NOT NULL_P                { ctx.list(&[attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::NOT_NULL))]) }
  | NULL_P                    { ctx.list(&[attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::NULL_))]) }
  | UNIQUE sql_opt_definition {
      ctx.list(
          &[
              attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::UNIQUE)),
              attr(Key::SQL_COLUMN_CONSTRAINT_DEFINITION, ctx.array(@2, $2)),
          ],
      )
  }
  | PRIMARY KEY sql_opt_definition {
      ctx.list(
          &[
              attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::PRIMARY_KEY)),
              attr(Key::SQL_COLUMN_CONSTRAINT_DEFINITION, ctx.array(@3, $3)),
          ],
      )
  }
  | CHECK_P LRB sql_a_expr RRB sql_opt_no_inherit {
      ctx.list(
          &[
              attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::CHECK)),
              attr(Key::SQL_COLUMN_CONSTRAINT_VALUE, ctx.expression($3)),
              attr(Key::SQL_COLUMN_CONSTRAINT_NO_INHERIT, $5),
          ],
      )
  }
  | DEFAULT sql_b_expr {
      ctx.list(
          &[
              attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, enum_node(@$, ColumnConstraint::DEFAULT)),
              attr(Key::SQL_COLUMN_CONSTRAINT_VALUE, ctx.expression($2)),
          ],
      )
  }
    ;

sql_opt_no_inherit:
    NO INHERIT  { bool_node(@1, true) }
  | %empty      { bool_node(@$, false) }
    ;

sql_create_generic_options:
    OPTIONS LRB sql_generic_option_list RRB     { ctx.array(@$, $3) }
  | %empty                                      { null() }
    ;

sql_generic_option_list:
    sql_generic_option_elem                                 { ctx.list(&[$1]) }
  | sql_generic_option_list COMMA sql_generic_option_elem     {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_generic_option_elem:
    sql_col_label SCONST {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_GENERIC_OPTION,
            &[
                attr(Key::SQL_GENERIC_OPTION_KEY, $1),
                attr(Key::SQL_GENERIC_OPTION_VALUE, const_node(@2, AConstType::STRING)),
            ],
        )
    }
    ;

sql_opt_column_list:
    LRB sql_column_list RRB { $2 }
  | %empty                  { ctx.list(NO_NODES) }

sql_column_list:
    sql_column_elem                     { ctx.list(&[$1]) }
  | sql_column_list COMMA sql_column_elem {
      ctx.push_back($1, $3);
      $1
  }
    ;

sql_column_elem: sql_col_id   { $1 };

sql_opt_with_data:
    WITH DATA_P         { bool_node(@$, true) }
  | WITH NO DATA_P      { bool_node(@$, false) }
  | %empty              { null() }
    ;

sql_opt_temp:
    TEMPORARY           { enum_node(@$, TempType::LOCAL) }
  | TEMP                { enum_node(@$, TempType::LOCAL) }
  | LOCAL TEMPORARY     { enum_node(@$, TempType::LOCAL) }
  | LOCAL TEMP          { enum_node(@$, TempType::LOCAL) }
  | GLOBAL TEMPORARY    { enum_node(@$, TempType::GLOBAL) }
  | GLOBAL TEMP         { enum_node(@$, TempType::GLOBAL) }
  | UNLOGGED            { enum_node(@$, TempType::UNLOGGED) }
  | %empty              { null() }
    ;

sql_on_commit_option: 
    ON COMMIT DROP              { enum_node(@$, OnCommitOption::DROP) }
  | ON COMMIT DELETE_P ROWS     { enum_node(@$, OnCommitOption::DELETE_ROWS) }
  | ON COMMIT PRESERVE ROWS     { enum_node(@$, OnCommitOption::PRESERVE_ROWS) }
  | %empty                      { null() }
  ;

// XXX omitted reloptions and OIDS
sql_opt_with:
    %empty          { null() }
    ;

sql_table_constraint:
    CONSTRAINT sql_name sql_table_constraint_elem {
        ctx.push_back($3, attr(Key::SQL_TABLE_CONSTRAINT_NAME, $2));
        ctx.object(@$, NodeType::OBJECT_SQL_TABLE_CONSTRAINT, $3)
    }
  | sql_table_constraint_elem { ctx.object(@$, NodeType::OBJECT_SQL_TABLE_CONSTRAINT, $1) }
    ;

sql_existing_index:
    USING INDEX sql_col_id  { $3 }
    ;

sql_table_constraint_elem:
    CHECK_P LRB sql_a_expr RRB sql_table_constraint_attr_list {
        ctx.list(
            &[
                attr(Key::SQL_TABLE_CONSTRAINT_TYPE, enum_node(@$, TableConstraint::CHECK)),
                attr(Key::SQL_TABLE_CONSTRAINT_ARGUMENT, ctx.expression($3)),
            ],
        )
    }
  | UNIQUE sql_existing_index sql_opt_definition sql_table_constraint_attr_list {
      ctx.list(
          &[
              attr(Key::SQL_TABLE_CONSTRAINT_TYPE, enum_node(@$, TableConstraint::UNIQUE)),
              attr(Key::SQL_TABLE_CONSTRAINT_INDEX, $2),
              attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.array(@3, $3)),
              attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.array(@4, $4)),
          ],
      )
  }
  | UNIQUE sql_opt_column_list sql_opt_definition sql_table_constraint_attr_list {
      ctx.list(
          &[
              attr(Key::SQL_TABLE_CONSTRAINT_TYPE, enum_node(@1, TableConstraint::UNIQUE)),
              attr(Key::SQL_TABLE_CONSTRAINT_COLUMNS, ctx.array(@2, $2)),
              attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.array(@3, $3)),
              attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.array(@4, $4)),
          ],
      )
  }
  | PRIMARY KEY sql_existing_index sql_opt_definition sql_table_constraint_attr_list {
      ctx.list(
          &[
              attr(Key::SQL_TABLE_CONSTRAINT_TYPE, enum_node(@$, TableConstraint::UNIQUE)),
              attr(Key::SQL_TABLE_CONSTRAINT_INDEX, $3),
              attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.array(@4, $4)),
              attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.array(@5, $5)),
          ],
      )
  }
  | PRIMARY KEY sql_opt_column_list sql_opt_definition sql_table_constraint_attr_list {
      ctx.list(
          &[
              attr(Key::SQL_TABLE_CONSTRAINT_TYPE, enum_node(@$, TableConstraint::PRIMARY_KEY)),
              attr(Key::SQL_TABLE_CONSTRAINT_COLUMNS, ctx.array(@3, $3)),
              attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.array(@4, $4)),
              attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.array(@5, $5)),
          ],
      )
  }
  | FOREIGN KEY sql_opt_column_list REFERENCES sql_qualified_name sql_opt_column_list sql_table_constraint_attr_list sql_key_match sql_key_actions {
      ctx.list(
          &[
              attr(Key::SQL_TABLE_CONSTRAINT_TYPE, enum_node(loc(&[@1, @2]), TableConstraint::FOREIGN_KEY)),
              attr(Key::SQL_TABLE_CONSTRAINT_COLUMNS, ctx.array(@3, $3)),
              attr(Key::SQL_TABLE_CONSTRAINT_REFERENCES_NAME, $5),
              attr(Key::SQL_TABLE_CONSTRAINT_REFERENCES_COLUMNS, ctx.array(@6, $6)),
              attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.array(@7, $7)),
              attr(Key::SQL_TABLE_CONSTRAINT_KEY_ACTIONS, ctx.array(@9, $9)),
              attr(Key::SQL_TABLE_CONSTRAINT_KEY_MATCH, $8),
          ],
      )
  }
    ;

sql_key_match:
    MATCH FULL      { enum_node(@$, KeyMatch::FULL) }
  | MATCH PARTIAL   { enum_node(@$, KeyMatch::PARTIAL) }
  | MATCH SIMPLE    { enum_node(@$, KeyMatch::SIMPLE) }
  | %empty          { null() }
    ;

sql_key_actions:
    sql_key_update  { ctx.list(&[$1]) }
  | sql_key_delete  { ctx.list(&[$1]) }
  | sql_key_update sql_key_delete { ctx.list(&[$1, $2]) }
  | sql_key_delete sql_key_update { ctx.list(&[$1, $2]) }
  | %empty          { ctx.list(NO_NODES) }
    ;

sql_key_update:
    ON UPDATE sql_key_action_command {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_KEY_ACTION,
            &[
                attr(Key::SQL_KEY_ACTION_TRIGGER, enum_node(loc(&[@1, @2]), KeyActionTrigger::UPDATE)),
                attr(Key::SQL_KEY_ACTION_COMMAND, $3),
            ],
        )
    }
    ;

sql_key_delete:
    ON DELETE_P sql_key_action_command {
        ctx.object(
            @$,
            NodeType::OBJECT_SQL_KEY_ACTION,
            &[
                attr(Key::SQL_KEY_ACTION_TRIGGER, enum_node(loc(&[@1, @2]), KeyActionTrigger::DELETE)),
                attr(Key::SQL_KEY_ACTION_COMMAND, $3),
            ],
        )
    }
    ;

sql_key_action_command:
    NO ACTION     { enum_node(@$, KeyActionCommand::NO_ACTION) }
  | RESTRICT      { enum_node(@$, KeyActionCommand::RESTRICT) }
  | CASCADE       { enum_node(@$, KeyActionCommand::CASCADE) }
  | SET NULL_P    { enum_node(@$, KeyActionCommand::SET_NULL) }
  | SET DEFAULT   { enum_node(@$, KeyActionCommand::SET_DEFAULT) }
    ;

sql_table_constraint_attr_list:
    sql_table_constraint_attr_list sql_table_constraint_attr_elem {
        ctx.push_back($1, $2);
        $1
    }
  | %empty { ctx.list(NO_NODES) }
    ;

sql_table_constraint_attr_elem:
    NOT DEFERRABLE        { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
  | DEFERRABLE            { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
  | INITIALLY IMMEDIATE   { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
  | INITIALLY DEFERRED    { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
  | NOT VALID             { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
  | NO INHERIT            { enum_node(@$, ConstraintAttribute::DEFERRABLE) }
    ;
