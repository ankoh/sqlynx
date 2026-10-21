set_statement:
    SET vararg_key_path EQUALS vararg_value {
        let varargs = vararg_field(ctx, loc(&[@2, @3, @4]), $2, $4);
        ctx.object(@$, NodeType::OBJECT_EXT_SET, &[attr(Key::EXT_SET_VARARGS, varargs)])
    }
