import { EditorView, ViewUpdate, PluginValue, ViewPlugin, DecorationSet, Decoration } from "@codemirror/view";
import { RangeSetBuilder, StateField, StateEffect, EditorState, Transaction, Facet } from "@codemirror/state"

export class FlatSQLEditorConfig {};

class FlatSQLEditorState {
    apply(_tr: Transaction) {
        console.log("APPLY TRANSACTION")
        return new FlatSQLEditorState();
    }
    static init(state: EditorState) {
        console.log(state);
        return new FlatSQLEditorState();
    }
};

const FLATSQL_SET_STATE = StateEffect.define<FlatSQLEditorState>();
const FLATSQL_STATE_FIELD = StateField.define<FlatSQLEditorState>({
    create: FlatSQLEditorState.init,
    update: (value, transaction) => {
        console.log("UPDATE STATE");
        for (let e of transaction.effects) if (e.is(FLATSQL_SET_STATE)) return e.value
        return value.apply(transaction)
    }
    },
);

class FlatSQLParser implements PluginValue {
    constructor(readonly view: EditorView) {
        let builder = new RangeSetBuilder<Decoration>();
    }
    update(_update: ViewUpdate) {
        console.log("UPDATE PARSER");
    }
    destroy() {}
};

class FlatSQLHighlighter implements PluginValue {
    decorations: DecorationSet;

    constructor(readonly view: EditorView) {
        let builder = new RangeSetBuilder<Decoration>();
        this.decorations = builder.finish();
    }
    update(_update: ViewUpdate) {
        console.log("UPDATE HIGHLIGHTER");
    }
    destroy() {}
};

export const FlatSQLEditorExtension = Facet.define<FlatSQLEditorConfig, FlatSQLEditorConfig | null>({
    // Just use the first config
    combine(configs) { return configs.length ? configs[0] : null },
    // Enable the extension
    enables: _ => [
        FLATSQL_STATE_FIELD,
        ViewPlugin.fromClass(FlatSQLParser, {}),
        ViewPlugin.fromClass(FlatSQLHighlighter, {
            decorations: v => v.decorations
        }),
    ]
  })