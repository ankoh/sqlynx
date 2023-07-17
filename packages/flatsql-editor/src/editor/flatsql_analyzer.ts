import * as flatsql from '@ankoh/flatsql';
import { StateField, StateEffect, StateEffectType, Text, Transaction } from '@codemirror/state';

/// A FlatSQL script key
export type FlatSQLScriptKey = number;
/// A FlatSQL script update
export interface FlatSQLScriptUpdate {
    // The key of the currently active script
    scriptKey: FlatSQLScriptKey;
    // The currently active script in the editor
    script: flatsql.FlatSQLScript | null;
    // The second script
    external: flatsql.FlatSQLScript | null;
    /// The previous analysis data (if any)
    data: FlatSQLAnalysisData;
    // This callback is called when the editor updates the script
    onUpdate: (scriptKey: FlatSQLScriptKey, script: FlatSQLAnalysisData) => void;
}
/// The state of a FlatSQL script
export interface FlatSQLAnalysisData {
    /// The scanned script
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    parsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    analyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// Destroy the state.
    /// The user is responsible for cleanup up FlatBufferRefs that are no longer needed.
    /// E.g. one strategy may be to destroy the "old" state once a script with the same script key is emitted.
    destroy: (state: FlatSQLAnalysisData) => void;
}
/// The state of a FlatSQL analyzer
type FlatSQLAnalyzerState = FlatSQLScriptUpdate;

/// Analyze a script
export function analyzeScript(
    script: flatsql.FlatSQLScript,
    external: flatsql.FlatSQLScript | null,
): FlatSQLAnalysisData {
    // Scan the script
    console.time('Script Scanning');
    const scanned = script.scan();
    console.timeEnd('Script Scanning');

    // Parse the script
    console.time('Script Parsing');
    const parsed = script.parse();
    console.timeEnd('Script Parsing');

    // Parse the script
    console.time('Script Analyzing');
    const analyzed = script.analyze(external);
    console.timeEnd('Script Analyzing');

    return { scanned, parsed, analyzed, destroy: destroyAnalysisData };
}

/// Destory the analyzer state
const destroyAnalysisData = (state: FlatSQLAnalysisData) => {
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
            external: null,
            data: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: destroyAnalysisData,
            },
            onUpdate: () => ({
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: destroyAnalysisData,
            }),
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: FlatSQLAnalyzerState, transaction: Transaction) => {
        // Did the user provide us with a new FlatSQL script?
        for (const effect of transaction.effects) {
            if (effect.is(UpdateFlatSQLScript) && state.script !== effect.value.script) {
                return {
                    ...state,
                    scriptKey: effect.value.scriptKey,
                    script: effect.value.script,
                    external: effect.value.external,
                    data: effect.value.data,
                    onUpdate: effect.value.onUpdate,
                };
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
            // Analyze the new script
            const next = { ...state };
            next.data = analyzeScript(next.script!, next.external);
            next.onUpdate(next.scriptKey, next.data);
            return next;
        }
        return state;
    },
});
