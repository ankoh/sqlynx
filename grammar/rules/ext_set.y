set_statement:
    SET vararg_key_path EQUALS vararg_value {
        auto varargs = VarArgField(ctx, Loc({@2, @3, @4}), std::move($2), $4);
        $$ = ctx.Object(@$, proto::NodeType::OBJECT_EXT_SET, {
            Attr(Key::EXT_SET_VARARGS, varargs)
        });
    }
