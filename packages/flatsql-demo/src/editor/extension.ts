import { EditorView, ViewUpdate, PluginValue, ViewPlugin, DecorationSet, Decoration } from "@codemirror/view";
import { RangeSetBuilder, StateField, StateEffect, EditorState, Transaction, Facet } from "@codemirror/state"

/// A configuration for a FlatSQL editor extension.
/// We use this configuration to inject the WebAssembly module.
export class FlatSQLExtensionConfig {};

/// A state effect to overwrite the editor state with a given value
const FLATSQL_EFFECT_SET_STATE = StateEffect.define<FlatSQLExtensionState>();
/// A state effect to increment a dummy counter
const FLATSQL_EFFECT_DUMMY = StateEffect.define<FlatSQLExtensionState>();

/// A FlatSQL editor state.
/// This state can be resolved in the individual plugins through the CodeMirror StateField FLATSQL_STATE_FIELD.
class FlatSQLExtensionState {
    counter: number;

    constructor() {
        this.counter = 0;
    }
    
    apply(tr: Transaction) {

        // Copy-on-write
        let result: FlatSQLExtensionState = this;
        const cow = () => {
            if (result == this) {
                result = new FlatSQLExtensionState();
                result.counter = this.counter;
            }
            return result;
        };

        // Find out if the transaction mutates us
        for (let e of tr.effects) {
            if (e.is(FLATSQL_EFFECT_SET_STATE)) {
                return e.value;
            }
            if (e.is(FLATSQL_EFFECT_DUMMY)) {
                cow().counter += 1;
            }
        }
        return result;
    }
    static init(_state: EditorState) {
        return new FlatSQLExtensionState();
    }
};

/// A state field to resolve the shared FlatSQL state
const FLATSQL_STATE_FIELD = StateField.define<FlatSQLExtensionState>({
    create: FlatSQLExtensionState.init,
    update: (value, transaction) => value.apply(transaction),
});

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class FlatSQLParser implements PluginValue {
    encoder: TextEncoder;

    constructor(readonly view: EditorView) {
        this.encoder = new TextEncoder();
    }
    update(update: ViewUpdate) {
        if (!update.docChanged) {
            return;
        }

        // Collect the text buffers
        console.time('UTF-8 Encoding');
        let textBuffers = [];
        let textLength = 0;
        for (let iter = this.view.state.doc.iter(); !iter.done; iter = iter.next()) {
            const buffer = this.encoder.encode(iter.value);
            textLength += buffer.byteLength;
            textBuffers.push(buffer);
        }
        console.timeEnd('UTF-8 Encoding');

        // Resolve the parser


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
    update(update: ViewUpdate) {
        if (!update.docChanged) {
            return;
        }
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