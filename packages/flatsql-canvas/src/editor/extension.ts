import * as flatsql from '@ankoh/flatsql';
import { EditorView, ViewUpdate, PluginValue, ViewPlugin, DecorationSet, Decoration } from '@codemirror/view';
import {
    RangeSetBuilder,
    StateField,
    StateEffect,
    EditorState,
    Transaction,
    Facet,
    Text as CMText,
} from '@codemirror/state';

/// A configuration for a FlatSQL editor extension.
/// We use this configuration to inject the WebAssembly module.
export interface FlatSQLExtensionConfig {
    /// The API
    instance: flatsql.FlatSQL;
    /// The rope
    script: flatsql.FlatSQLScript;
}

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
}

/// A state field to resolve the shared FlatSQL state
const FLATSQL_STATE_FIELD = StateField.define<FlatSQLExtensionState>({
    create: FlatSQLExtensionState.init,
    update: (value, transaction) => value.apply(transaction),
});

/// A FlatSQL parser plugin that parses the CodeMirror text whenever it changes
class FlatSQLParser implements PluginValue {
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
        if (!update.docChanged) {
            return;
        }

        // Resolve the parser
        const ext = this.view.state.facet(FlatSQLExtension)!;
        if (!ext.instance) {
            console.warn('FlatSQL module not set');
            return;
        }

        // Insert the text
        console.time('Rope Insert');
        update.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, inserted: CMText) => {
            if (toA - fromA > 0) {
                ext.script.eraseTextRange(fromA, toA - fromA);
            }
            if (inserted.length > 0) {
                let writer = fromB;
                for (const text of inserted.iter()) {
                    ext.script.insertTextAt(writer, text);
                    writer += text.length;
                }
            }
        });
        console.timeEnd('Rope Insert');

        // Scan the script
        console.time('Script Scanning');
        const scannerRes = ext.script.scan();
        scannerRes.delete();
        console.timeEnd('Script Scanning');

        // Parse the script
        console.time('Script Parsing');
        const parserRes = ext.script.parse();
        parserRes.delete();
        console.timeEnd('Script Parsing');

        // Parse the script
        console.time('Script Analyzing');
        const analyzerRes = ext.script.analyze();
        analyzerRes.delete();
        console.timeEnd('Script Analyzing');

        // console.log(ext.script.toString());
    }
    destroy() {}
}

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
}

/// A facet to setup the CodeMirror extensions.
///
/// Example usage:
/// ```
///     const config = new FlatSQLExtensionConfig(parser);
///     return (<CodeMirror extensions={[ FlatSQLExtension.of(config) ]} />);
/// ```
export const FlatSQLExtension = Facet.define<FlatSQLExtensionConfig, FlatSQLExtensionConfig | null>({
    // Just use the first config
    combine(configs) {
        return configs.length ? configs[0] : null;
    },
    // Enable the extension
    enables: _ => [
        FLATSQL_STATE_FIELD,
        ViewPlugin.fromClass(FlatSQLParser, {}),
        ViewPlugin.fromClass(FlatSQLHighlighter, {
            decorations: v => v.decorations,
        }),
    ],
});
