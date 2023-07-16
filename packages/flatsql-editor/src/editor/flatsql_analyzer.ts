import * as flatsql from '@ankoh/flatsql';
import { StateField, StateEffect, StateEffectType, Text, Transaction } from '@codemirror/state';

/// A FlatSQL script key
export type FlatSQLScriptKey = number;
/// The state of a FlatSQL script
export interface FlatSQLScriptState {
    /// The script key
    scriptKey: FlatSQLScriptKey;
    /// The script
    script: flatsql.FlatSQLScript | null;
    /// The scanned script
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    parsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    analyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// Destroy the state.
    /// The user is responsible for cleanup up FlatBufferRefs that are no longer needed.
    /// E.g. one strategy may be to destroy the "old" state once a script with the same script key is emitted.
    destroy: (state: FlatSQLScriptState) => void;
}

/// The state of a FlatSQL analyzer
export interface FlatSQLAnalyzerState extends FlatSQLScriptState {
    // This callback is called when the editor updates the script
    onUpdate: (state: FlatSQLAnalyzerState) => void;
}

/// A FlatSQL script update
export interface FlatSQLScriptUpdate {
    // The currently active script
    scriptKey: FlatSQLScriptKey;
    // The currently active script
    script: flatsql.FlatSQLScript | null;
    // This callback is called when the editor updates the script
    onUpdate: (state: FlatSQLScriptState) => void;
}

/// Analyze a script
function analyze(state: FlatSQLAnalyzerState): FlatSQLAnalyzerState {
    if (!state.script) return state;
    state.scanned = null;
    state.parsed = null;
    state.analyzed = null;
    // Scan the script
    console.time('Script Scanning');
    state.scanned = state.script.scan();
    console.timeEnd('Script Scanning');

    // Parse the script
    console.time('Script Parsing');
    state.parsed = state.script.parse();
    console.timeEnd('Script Parsing');

    // Parse the script
    console.time('Script Analyzing');
    state.analyzed = state.script.analyze();
    console.timeEnd('Script Analyzing');
    return state;
}

/// Destory the analyzer state
const destroyScriptState = (state: FlatSQLScriptState) => {
    if (state.scanned != null) {
        state.scanned.delete();
        state.scanned = null;
    }
    if (state.parsed != null) {
        state.parsed.delete();
        state.parsed = null;
    }
    if (state.analyzed != null) {
        state.analyzed.delete();
        state.analyzed = null;
    }
    return state;
};

/// Effect to update a FlatSQL script attached to a CodeMirror editor
export const UpdateFlatSQLScript: StateEffectType<FlatSQLScriptUpdate> = StateEffect.define<FlatSQLScriptUpdate>();
/// An analyzer for FlatSQL scripts
export const FlatSQLAnalyzer: StateField<FlatSQLAnalyzerState> = StateField.define<FlatSQLAnalyzerState>({
    // Create the initial state
    create: () => {
        // By default, the FlatSQL script is not configured
        const config: FlatSQLAnalyzerState = {
            scriptKey: 0,
            script: null,
            scanned: null,
            parsed: null,
            analyzed: null,
            onUpdate: () => {},
            destroy: destroyScriptState,
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: FlatSQLAnalyzerState, transaction: Transaction) => {
        // Did the user provide us with a new FlatSQL script?
        for (const effect of transaction.effects) {
            if (effect.is(UpdateFlatSQLScript) && state.script !== effect.value.script) {
                // Warn the user if he forgot to also change the script text
                if (transaction.changes.empty) {
                    console.warn('FlatSQL script was updated without changing the document');
                }
                // Create next state
                const next = {
                    ...state,
                    scriptKey: effect.value.scriptKey,
                    script: effect.value.script,
                    onUpdate: effect.value.onUpdate,
                    destroy: destroyScriptState,
                };
                // Analyze a script if it is not null
                if (next.script != null) {
                    analyze(next);
                }
                // Update the state
                next.onUpdate(next);
                return next;
            }
        }
        // Did the document change?
        if (state.script != null && transaction.docChanged) {
            // Mirror all changes to the the FlatSQL script, if the script is != null.
            transaction.changes.iterChanges(
                (fromA: number, toA: number, fromB: number, toB: number, inserted: Text) => {
                    if (toA - fromA > 0) {
                        state.script!.eraseTextRange(fromA, toA - fromA);
                    }
                    if (inserted.length > 0) {
                        let writer = fromB;
                        for (const text of inserted.iter()) {
                            state.script!.insertTextAt(writer, text);
                            writer += text.length;
                        }
                    }
                },
            );
            // Save the old state
            const next = { ...state };
            // Analyze the new script
            analyze(next);
            // Call the user update
            next.onUpdate(next);
            state = next;
        }
        return state;
    },
});
