set_statement:
    SET vararg_key_path '=' vararg_value {
        auto val = ctx.AddVarArgField(Loc({@2, @3, @4}), move($2), $4);
        auto obj = ctx.Add(Loc({@2, @3, @4}), proto::NodeType::OBJECT_EXT_VARARGS, { val });
        $$ = ctx.Add(@$, proto::NodeType::OBJECT_EXT_SET, {
            Attr(Key::EXT_SET_FIELDS, obj)
        });
    }