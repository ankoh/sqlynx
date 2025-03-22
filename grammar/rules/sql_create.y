sql_create_as_stmt:
    CREATE_P sql_opt_temp TABLE sql_create_as_target AS sql_select_stmt sql_opt_with_data {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_CREATE_AS, Concat(std::move($4), {
            Attr(Key::SQL_CREATE_AS_TEMP, $2),
            Attr(Key::SQL_CREATE_AS_STATEMENT, ctx.Object(@6, buffers::NodeType::OBJECT_SQL_SELECT, std::move($6))),
            Attr(Key::SQL_CREATE_AS_WITH_DATA, $7),
        }));
    }
  | CREATE_P sql_opt_temp TABLE IF_P NOT EXISTS sql_create_as_target AS sql_select_stmt sql_opt_with_data {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_CREATE_AS, Concat(std::move($7), {
            Attr(Key::SQL_CREATE_AS_IF_NOT_EXISTS, Bool(Loc({@4, @5, @6}), true)),
            Attr(Key::SQL_CREATE_AS_TEMP, $2),
            Attr(Key::SQL_CREATE_AS_STATEMENT, ctx.Object(@9, buffers::NodeType::OBJECT_SQL_SELECT, std::move($9))),
            Attr(Key::SQL_CREATE_AS_WITH_DATA, $10),
        }));
    }
    ;

sql_create_as_target:
    sql_qualified_name sql_opt_column_list sql_opt_with sql_on_commit_option {
        $$ = ctx.List({
            Attr(Key::SQL_CREATE_AS_NAME, std::move($1)),
            Attr(Key::SQL_CREATE_AS_COLUMNS, ctx.Array(@2, std::move($2))),
            Attr(Key::SQL_CREATE_AS_ON_COMMIT, $4)
        });
    }
    ;
    
sql_create_stmt:
    CREATE_P sql_opt_temp TABLE sql_qualified_name LRB sql_opt_table_element_list RRB sql_on_commit_option {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_CREATE, {
            Attr(Key::SQL_CREATE_TABLE_TEMP, $2),
            Attr(Key::SQL_CREATE_TABLE_NAME, std::move($4)),
            Attr(Key::SQL_CREATE_TABLE_ELEMENTS, ctx.Array(Loc({@5, @6, @7}), std::move($6))),
            Attr(Key::SQL_CREATE_TABLE_ON_COMMIT, $8),
        });
    }
  | CREATE_P sql_opt_temp TABLE IF_P NOT EXISTS sql_qualified_name LRB sql_opt_table_element_list RRB sql_on_commit_option {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_CREATE, {
            Attr(Key::SQL_CREATE_TABLE_TEMP, $2),
            Attr(Key::SQL_CREATE_TABLE_IF_NOT_EXISTS, Bool(Loc({@4, @5, @6}), true)),
            Attr(Key::SQL_CREATE_TABLE_NAME, std::move($7)),
            Attr(Key::SQL_CREATE_TABLE_ELEMENTS, ctx.Array(Loc({@8, @9, @10}), std::move($9))),
            Attr(Key::SQL_CREATE_TABLE_ON_COMMIT, $11),
        });
    }
    ;

sql_opt_table_element_list:
    sql_table_element_list  { $$ = std::move($1); }
  | %empty                  { $$ = ctx.List(); }
    ;

sql_table_element_list:
    sql_table_element                             { $$ = ctx.List({ $1 }); }
  | sql_table_element_list COMMA sql_table_element  { $1->push_back(std::move($3)); $$ = std::move($1); }
    ;

sql_table_element:
    sql_column_def        { $$ = std::move($1); }
  | sql_table_constraint  { $$ = std::move($1); }
    ;

sql_column_def:
    sql_col_id sql_typename sql_create_generic_options sql_col_qual_list {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_COLUMN_DEF, {
            Attr(Key::SQL_COLUMN_DEF_NAME, $1),
            Attr(Key::SQL_COLUMN_DEF_TYPE, std::move($2)),
            Attr(Key::SQL_COLUMN_DEF_OPTIONS, std::move($3)),
            Attr(Key::SQL_COLUMN_DEF_CONSTRAINTS, ctx.Array(@4, std::move($4)))
        });
    }
    ;

sql_col_qual_list:
    sql_col_qual_list sql_col_constraint    { $1->push_back(std::move($2)); $$ = std::move($1); }
  | %empty                                  { $$ = ctx.List(); }
    ;

sql_col_constraint:
    CONSTRAINT sql_name sql_col_constraint_elem {
        $3->push_back(Attr(Key::SQL_COLUMN_CONSTRAINT_NAME, $2));
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_COLUMN_CONSTRAINT, std::move($3));
    }
  | sql_col_constraint_elem { $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_COLUMN_CONSTRAINT, std::move($1)); }
  | sql_col_constraint_attr { $$ = std::move($1); }
  | COLLATE sql_any_name    { $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_COLUMN_CONSTRAINT, {
        Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::COLLATE)),
        Attr(Key::SQL_COLUMN_CONSTRAINT_COLLATE, ctx.Array(@2, std::move($2))),
    });
  }
    ;

sql_col_constraint_attr:
    DEFERRABLE              { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
  | NOT DEFERRABLE          { $$ = Enum(@$, buffers::ConstraintAttribute::NOT_DEFERRABLE); }
  | INITIALLY DEFERRED      { $$ = Enum(@$, buffers::ConstraintAttribute::INITIALLY_DEFERRED); }
  | INITIALLY IMMEDIATE     { $$ = Enum(@$, buffers::ConstraintAttribute::INITIALLY_IMMEDIATE); }
    ;

sql_opt_definition:
    WITH sql_definition     { $$ = std::move($2); }
  | %empty                  { $$ = ctx.List(); }
    ;

sql_definition: LRB sql_def_list RRB { $$ = std::move($2); }

sql_def_list: 
    sql_def_elem                    { $$ = ctx.List({ std::move($1) }); }
  | sql_def_list COMMA sql_def_elem   { $1->push_back($3); $$ = std::move($1); }
    ;

sql_def_elem:
    sql_col_label EQUALS sql_def_arg {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_DEF_ARG, {
            Attr(Key::SQL_DEFINITION_ARG_KEY, std::move($1)),
            Attr(Key::SQL_DEFINITION_ARG_VALUE, std::move(std::move($3))),
        });
    }
    ;

sql_def_arg:
    sql_func_type           { $$ = std::move($1); }
  | sql_reserved_keywords   { $$ = ctx.NameFromKeyword(@1, $1); }
  | sql_qual_all_op         { $$ = std::move($1); }
  | sql_numeric_only        { $$ = std::move($1); }
  | SCONST                  { $$ = Const(@1, buffers::AConstType::STRING); }
  | NONE                    { $$ = Null(); }
    ;

sql_numeric_only:
    FCONST              { $$ = Const(@$, buffers::AConstType::FLOAT); }
  | PLUS FCONST          { $$ = Const(@$, buffers::AConstType::FLOAT); }
  | MINUS FCONST          { $$ = Const(@$, buffers::AConstType::FLOAT); }
  | sql_signed_iconst   { $$ = std::move($1); }
    ;

sql_signed_iconst:
    ICONST      { $$ = Const(@$, buffers::AConstType::INTEGER); }
  | PLUS ICONST  { $$ = Const(@$, buffers::AConstType::INTEGER); }
  | MINUS ICONST  { $$ = Const(@$, buffers::AConstType::INTEGER); }
    ;

// XXX omitted SETOF
sql_func_type:
    sql_typename { $$ = std::move($1); }
    ;

// XXX omitted identity and foreign
sql_col_constraint_elem:
    NOT NULL_P                { $$ = ctx.List({ Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::NOT_NULL)) }); }
  | NULL_P                    { $$ = ctx.List({ Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::NULL_)) }); }
  | UNIQUE sql_opt_definition { $$ = ctx.List({
        Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::UNIQUE)),
        Attr(Key::SQL_COLUMN_CONSTRAINT_DEFINITION, ctx.Array(@2, std::move($2))),
    });
  }
  | PRIMARY KEY sql_opt_definition { $$ = ctx.List({
        Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::PRIMARY_KEY)),
        Attr(Key::SQL_COLUMN_CONSTRAINT_DEFINITION, ctx.Array(@3, std::move($3))),
    });
  }
  | CHECK_P LRB sql_a_expr RRB sql_opt_no_inherit { $$ = ctx.List({
        Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::CHECK)),
        Attr(Key::SQL_COLUMN_CONSTRAINT_VALUE, ctx.Expression(std::move($3))),
        Attr(Key::SQL_COLUMN_CONSTRAINT_NO_INHERIT, std::move($5)),
    });
  }
  | DEFAULT sql_b_expr { $$ = ctx.List({
        Attr(Key::SQL_COLUMN_CONSTRAINT_TYPE, Enum(@$, buffers::ColumnConstraint::DEFAULT)),
        Attr(Key::SQL_COLUMN_CONSTRAINT_VALUE, ctx.Expression(std::move($2))),
    });
  }
    ;

sql_opt_no_inherit:
    NO INHERIT  { $$ = Bool(@1, true); }
  | %empty      { $$ = Bool(@$, false); }
    ;

sql_create_generic_options:
    OPTIONS LRB sql_generic_option_list RRB     { $$ = ctx.Array(@$, std::move($3)); }
  | %empty                                      { $$ = Null(); }
    ;

sql_generic_option_list:
    sql_generic_option_elem                                 { $$ = ctx.List({ std::move($1) });  }
  | sql_generic_option_list COMMA sql_generic_option_elem     { $1->push_back(std::move($3)); $$ = std::move($1); }
    ;

sql_generic_option_elem:
    sql_col_label SCONST {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_GENERIC_OPTION, {
            Attr(Key::SQL_GENERIC_OPTION_KEY, $1),
            Attr(Key::SQL_GENERIC_OPTION_VALUE, Const(@2, sx::AConstType::STRING)),
        });
    }
    ;

sql_opt_column_list:
    LRB sql_column_list RRB { $$ = std::move($2); }
  | %empty                  { $$ = ctx.List(); }

sql_column_list:
    sql_column_elem                     { $$ = ctx.List({ $1 }); }
  | sql_column_list COMMA sql_column_elem { $1->push_back($3); $$ = std::move($1); }
    ;

sql_column_elem: sql_col_id   { $$ = $1; };

sql_opt_with_data:
    WITH DATA_P         { $$ = Bool(@$, true); }
  | WITH NO DATA_P      { $$ = Bool(@$, false); }
  | %empty              { $$ = Null(); }
    ;

sql_opt_temp:
    TEMPORARY           { $$ = Enum(@$, buffers::TempType::LOCAL); }
  | TEMP                { $$ = Enum(@$, buffers::TempType::LOCAL); }
  | LOCAL TEMPORARY     { $$ = Enum(@$, buffers::TempType::LOCAL); }
  | LOCAL TEMP          { $$ = Enum(@$, buffers::TempType::LOCAL); }
  | GLOBAL TEMPORARY    { $$ = Enum(@$, buffers::TempType::GLOBAL); }
  | GLOBAL TEMP         { $$ = Enum(@$, buffers::TempType::GLOBAL); }
  | UNLOGGED            { $$ = Enum(@$, buffers::TempType::UNLOGGED); }
  | %empty              { $$ = Null(); }
    ;

sql_on_commit_option: 
    ON COMMIT DROP              { $$ = Enum(@$, buffers::OnCommitOption::DROP); }
  | ON COMMIT DELETE_P ROWS     { $$ = Enum(@$, buffers::OnCommitOption::DELETE_ROWS); }
  | ON COMMIT PRESERVE ROWS     { $$ = Enum(@$, buffers::OnCommitOption::PRESERVE_ROWS); }
  | %empty                      { $$ = Null(); }
  ;

// XXX omitted reloptions and OIDS
sql_opt_with:
    %empty          { $$ = Null(); }
    ;

sql_table_constraint:
    CONSTRAINT sql_name sql_table_constraint_elem {
        $3->push_back(Attr(Key::SQL_TABLE_CONSTRAINT_NAME, $2));
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_TABLE_CONSTRAINT, std::move($3));
    }
  | sql_table_constraint_elem {
        $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_TABLE_CONSTRAINT, std::move($1));
    }
    ;

sql_existing_index:
    USING INDEX sql_col_id  { $$ = $3; }
    ;

sql_table_constraint_elem:
    CHECK_P LRB sql_a_expr RRB sql_table_constraint_attr_list { $$ = ctx.List({
        Attr(Key::SQL_TABLE_CONSTRAINT_TYPE, Enum(@$, buffers::TableConstraint::CHECK)),
        Attr(Key::SQL_TABLE_CONSTRAINT_ARGUMENT, ctx.Expression(std::move($3))),
    }); }
  | UNIQUE sql_existing_index sql_opt_definition sql_table_constraint_attr_list { $$ = ctx.List({
        Attr(Key::SQL_TABLE_CONSTRAINT_TYPE, Enum(@$, buffers::TableConstraint::UNIQUE)),
        Attr(Key::SQL_TABLE_CONSTRAINT_INDEX, $2),
        Attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.Array(@3, std::move($3))),
        Attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.Array(@4, std::move($4))),
    }); }
  | UNIQUE sql_opt_column_list sql_opt_definition sql_table_constraint_attr_list { $$ = ctx.List({
        Attr(Key::SQL_TABLE_CONSTRAINT_TYPE, Enum(@1, buffers::TableConstraint::UNIQUE)),
        Attr(Key::SQL_TABLE_CONSTRAINT_COLUMNS, ctx.Array(@2, std::move($2))),
        Attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.Array(@3, std::move($3))),
        Attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.Array(@4, std::move($4))),
    }); }
  | PRIMARY KEY sql_existing_index sql_opt_definition sql_table_constraint_attr_list { $$ = ctx.List({
        Attr(Key::SQL_TABLE_CONSTRAINT_TYPE, Enum(@$, buffers::TableConstraint::UNIQUE)),
        Attr(Key::SQL_TABLE_CONSTRAINT_INDEX, $3),
        Attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.Array(@4, std::move($4))),
        Attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.Array(@5, std::move($5))),
    }); }
  | PRIMARY KEY sql_opt_column_list sql_opt_definition sql_table_constraint_attr_list { $$ = ctx.List({
        Attr(Key::SQL_TABLE_CONSTRAINT_TYPE, Enum(@$, buffers::TableConstraint::PRIMARY_KEY)),
        Attr(Key::SQL_TABLE_CONSTRAINT_COLUMNS, ctx.Array(@3, std::move($3))),
        Attr(Key::SQL_TABLE_CONSTRAINT_DEFINITION, ctx.Array(@4, std::move($4))),
        Attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.Array(@5, std::move($5))),
    }); }
  | FOREIGN KEY sql_opt_column_list REFERENCES sql_qualified_name sql_opt_column_list sql_table_constraint_attr_list sql_key_match sql_key_actions { $$ = ctx.List({
        Attr(Key::SQL_TABLE_CONSTRAINT_TYPE, Enum(Loc({@1, @2}), buffers::TableConstraint::FOREIGN_KEY)),
        Attr(Key::SQL_TABLE_CONSTRAINT_COLUMNS, ctx.Array(@3, std::move($3))),
        Attr(Key::SQL_TABLE_CONSTRAINT_REFERENCES_NAME, std::move($5)),
        Attr(Key::SQL_TABLE_CONSTRAINT_REFERENCES_COLUMNS, ctx.Array(@6, std::move($6))),
        Attr(Key::SQL_TABLE_CONSTRAINT_ATTRIBUTES, ctx.Array(@7, std::move($7))),
        Attr(Key::SQL_TABLE_CONSTRAINT_KEY_ACTIONS, ctx.Array(@9, std::move($9))),
        Attr(Key::SQL_TABLE_CONSTRAINT_KEY_MATCH, $8),
    }); }
    ;

sql_key_match:
    MATCH FULL      { $$ = Enum(@$, buffers::KeyMatch::FULL); }
  | MATCH PARTIAL   { $$ = Enum(@$, buffers::KeyMatch::PARTIAL); }
  | MATCH SIMPLE    { $$ = Enum(@$, buffers::KeyMatch::SIMPLE); }
  | %empty          { $$ = Null(); }
    ;

sql_key_actions:
    sql_key_update  { $$ = ctx.List({ $1 }); }
  | sql_key_delete  { $$ = ctx.List({ $1 }); }
  | sql_key_update sql_key_delete { $$ = ctx.List({ $1, $2 }); }
  | sql_key_delete sql_key_update { $$ = ctx.List({ $1, $2 }); }
  | %empty          { $$ = ctx.List(); }
    ;

sql_key_update:
    ON UPDATE sql_key_action_command { $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_KEY_ACTION, {
        Attr(Key::SQL_KEY_ACTION_TRIGGER, Enum(Loc({@1, @2}), buffers::KeyActionTrigger::UPDATE)),
        Attr(Key::SQL_KEY_ACTION_COMMAND, $3),
    }); }
    ;

sql_key_delete:
    ON DELETE_P sql_key_action_command { $$ = ctx.Object(@$, buffers::NodeType::OBJECT_SQL_KEY_ACTION, {
        Attr(Key::SQL_KEY_ACTION_TRIGGER, Enum(Loc({@1, @2}), buffers::KeyActionTrigger::DELETE)),
        Attr(Key::SQL_KEY_ACTION_COMMAND, $3),
    }); }
    ;

sql_key_action_command:
    NO ACTION     { $$ = Enum(@$, buffers::KeyActionCommand::NO_ACTION); }
  | RESTRICT      { $$ = Enum(@$, buffers::KeyActionCommand::RESTRICT); }
  | CASCADE       { $$ = Enum(@$, buffers::KeyActionCommand::CASCADE); }
  | SET NULL_P    { $$ = Enum(@$, buffers::KeyActionCommand::SET_NULL); }
  | SET DEFAULT   { $$ = Enum(@$, buffers::KeyActionCommand::SET_DEFAULT); }
    ;

sql_table_constraint_attr_list:
    sql_table_constraint_attr_list sql_table_constraint_attr_elem {
      $1->push_back($2);
      $$ = std::move($1);
    }
  | %empty { $$ = ctx.List(); }
    ;

sql_table_constraint_attr_elem:
    NOT DEFERRABLE        { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
  | DEFERRABLE            { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
  | INITIALLY IMMEDIATE   { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
  | INITIALLY DEFERRED    { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
  | NOT VALID             { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
  | NO INHERIT            { $$ = Enum(@$, buffers::ConstraintAttribute::DEFERRABLE); }
    ;
