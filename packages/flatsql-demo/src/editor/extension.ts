import { EditorView, ViewUpdate, PluginValue, ViewPlugin, DecorationSet, Decoration } from "@codemirror/view";
import { RangeSetBuilder, StateField, StateEffect, EditorState, Transaction, Facet } from "@codemirror/state"

/// A configuration for a FlatSQL editor extension.
/// We use this configuration to inject the WebAssembly module.
export class FlatSQLExtensionConfig {};

/// A FlatSQL editor state.
/// This state can be resolved in the individual plugins through the CodeMirror StateField FLATSQL_STATE_FIELD.
class FlatSQLExtensionState {
    apply(_tr: Transaction) {
        return new FlatSQLExtensionState();
    }
    static init(_state: EditorState) {
        console.log("INITIAL STATE");
        return new FlatSQLExtensionState();
    }
};

/// A state effect to overwrite the editor state with a given value
const FLATSQL_SET_STATE = StateEffect.define<FlatSQLExtensionState>();
/// A state field to resolve the shared FlatSQL state
const FLATSQL_STATE_FIELD = StateField.define<FlatSQLExtensionState>({
    create: FlatSQLExtensionState.init,
    update: (value, transaction) => {
        console.log("UPDATE STATE");
        for (let e of transaction.effects) if (e.is(FLATSQL_SET_STATE)) return e.value
        return value.apply(transaction)
    }
    },
);

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class FlatSQLParser implements PluginValue {
    constructor(readonly view: EditorView) {
        let builder = new RangeSetBuilder<Decoration>();
    }
    update(_update: ViewUpdate) {
        console.log("-- UPDATE PARSER");
    }
    destroy() {}
};

/// A FlatSQL highlighter plugin that emits highlighting decorations for a parsed SQL text
class FlatSQLHighlighter implements PluginValue {
    decorations: DecorationSet;

    constructor(readonly view: EditorView) {
        let builder = new RangeSetBuilder<Decoration>();
        this.decorations = builder.finish();
    }
    update(_update: ViewUpdate) {
        console.log("-- UPDATE HIGHLIGHTER");
    }
    destroy() {}
};

/// A facet to setup the CodeMirror extensions.
///
/// Example usage:
/// ```
///     const config = new FlatSQLExtensionConfig(parser);
///     return (<CodeMirror extensions={[ FlatSQLExtension.of(config) ]} />);
/// ```
export const FlatSQLExtension = Facet.define<FlatSQLExtensionConfig, FlatSQLExtensionConfig | null>({
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