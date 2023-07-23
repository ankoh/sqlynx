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
    /// The previous processed script data (if any)
    processed: FlatSQLProcessedScript;
    // This callback is called when the editor updates the script
    onUpdate: (scriptKey: FlatSQLScriptKey, script: FlatSQLProcessedScript) => void;
}
/// The FlatSQL script buffers
export interface FlatSQLProcessedScript {
    /// The scanned script
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    parsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    analyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// Destroy the state.
    /// The user is responsible for cleanup up FlatBufferRefs that are no longer needed.
    /// E.g. one strategy may be to destroy the "old" state once a script with the same script key is emitted.
    destroy: (state: FlatSQLProcessedScript) => void;
}
/// The state of a FlatSQL analyzer
type FlatSQLEditorState = FlatSQLScriptUpdate;

/// Analyze a new script
export function parseAndAnalyzeScript(
    script: flatsql.FlatSQLScript,
    external: flatsql.FlatSQLScript | null,
): FlatSQLProcessedScript {
    // Scan the script
    const scanned = script.scan();
    // Parse the script
    const parsed = script.parse();
    // Parse the script
    const analyzed = script.analyze(external);

    return { scanned, parsed, analyzed, destroy: destroyBuffers };
}

/// Analyze an existing script
export function analyzeScript(
    buffers: FlatSQLProcessedScript,
    script: flatsql.FlatSQLScript,
    external: flatsql.FlatSQLScript | null,
): FlatSQLProcessedScript {
    // Analyze the script
    console.time('Script Analyzing');
    const analyzed = script.analyze(external);
    console.timeEnd('Script Analyzing');

    return { ...buffers, analyzed };
}

/// Destory the buffers
const destroyBuffers = (state: FlatSQLProcessedScript) => {
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
/// A processor for FlatSQL scripts
export const FlatSQLProcessor: StateField<FlatSQLEditorState> = StateField.define<FlatSQLEditorState>({
    // Create the initial state
    create: () => {
        // By default, the FlatSQL script is not configured
        const config: FlatSQLEditorState = {
            scriptKey: 0,
            script: null,
            external: null,
            processed: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: destroyBuffers,
            },
            onUpdate: () => ({
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: destroyBuffers,
            }),
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: FlatSQLEditorState, transaction: Transaction) => {
        // Did the user provide us with a new FlatSQL script?
        for (const effect of transaction.effects) {
            if (
                effect.is(UpdateFlatSQLScript) &&
                (state.script !== effect.value.script || state.external !== effect.value.external)
            ) {
                return {
                    ...state,
                    scriptKey: effect.value.scriptKey,
                    script: effect.value.script,
                    external: effect.value.external,
                    processed: effect.value.processed,
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
            next.processed = parseAndAnalyzeScript(next.script!, next.external);
            next.onUpdate(next.scriptKey, next.processed);
            return next;
        }
        return state;
    },
});
