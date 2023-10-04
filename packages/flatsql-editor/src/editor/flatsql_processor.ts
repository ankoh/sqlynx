import * as flatsql from '@ankoh/flatsql';
import { StateField, StateEffect, StateEffectType, Text, Transaction } from '@codemirror/state';

/// A FlatSQL script key
export type FlatSQLScriptKey = number;
/// A FlatSQL script update
export interface FlatSQLScriptUpdate {
    // The key of the currently active script
    scriptKey: FlatSQLScriptKey;
    // The currently active script in the editor
    mainScript: flatsql.FlatSQLScript | null;
    // The second script
    externalScript: flatsql.FlatSQLScript | null;
    /// The previous processed script buffers (if any)
    scriptBuffers: FlatSQLScriptBuffers;
    /// The script cursor
    scriptCursor: flatsql.proto.ScriptCursorInfoT | null;
    /// The focused column references
    focusedColumnRefs: Set<flatsql.QualifiedID.Value> | null;
    /// The focused table references
    focusedTableRefs: Set<flatsql.QualifiedID.Value> | null;
    // This callback is called when the editor updates the script
    onUpdateScript: (
        scriptKey: FlatSQLScriptKey,
        script: FlatSQLScriptBuffers,
        cursor: flatsql.proto.ScriptCursorInfoT,
    ) => void;
    // This callback is called when the editor updates the cursor
    onUpdateScriptCursor: (scriptKey: FlatSQLScriptKey, cursor: flatsql.proto.ScriptCursorInfoT) => void;
}
/// The FlatSQL script buffers
export interface FlatSQLScriptBuffers {
    /// The scanned script
    scanned: flatsql.FlatBufferRef<flatsql.proto.ScannedScript> | null;
    /// The parsed script
    parsed: flatsql.FlatBufferRef<flatsql.proto.ParsedScript> | null;
    /// The analyzed script
    analyzed: flatsql.FlatBufferRef<flatsql.proto.AnalyzedScript> | null;
    /// Destroy the state.
    /// The user is responsible for cleanup up FlatBufferRefs that are no longer needed.
    /// E.g. one strategy may be to destroy the "old" state once a script with the same script key is emitted.
    destroy: (state: FlatSQLScriptBuffers) => void;
}
/// The state of a FlatSQL analyzer
type FlatSQLEditorState = FlatSQLScriptUpdate;

/// Analyze a new script
export function parseAndAnalyzeScript(
    script: flatsql.FlatSQLScript,
    external: flatsql.FlatSQLScript | null,
): FlatSQLScriptBuffers {
    // Scan the script
    const scanned = script.scan();
    // Parse the script
    const parsed = script.parse();
    // Parse the script
    const analyzed = script.analyze(external);
    // Parse the script
    script.reindex();

    return { scanned, parsed, analyzed, destroy: destroyBuffers };
}

/// Analyze an existing script
export function analyzeScript(
    buffers: FlatSQLScriptBuffers,
    script: flatsql.FlatSQLScript,
    external: flatsql.FlatSQLScript | null,
): FlatSQLScriptBuffers {
    // Delete the old analysis
    buffers.analyzed?.delete();
    // Analyze the script
    const analyzed = script.analyze(external);
    // Return the new script
    return { ...buffers, analyzed };
}

/// Destory the buffers
const destroyBuffers = (state: FlatSQLScriptBuffers) => {
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
            mainScript: null,
            externalScript: null,
            scriptBuffers: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: destroyBuffers,
            },
            scriptCursor: null,
            focusedColumnRefs: null,
            focusedTableRefs: null,
            onUpdateScript: () => {},
            onUpdateScriptCursor: () => {},
        };
        return config;
    },
    // Mirror the FlatSQL state
    update: (state: FlatSQLEditorState, transaction: Transaction) => {
        // Did the selection change?
        const prevSelection = transaction.startState.selection.asSingle();
        const newSelection = transaction.newSelection.asSingle();
        const cursorChanged = !prevSelection.eq(newSelection);
        let selection: number | null = newSelection.main.to;
        let next: FlatSQLEditorState = state;

        const copyIfNotReplaced = () => {
            next = next === state ? { ...state } : state;
        };

        // Did the user provide us with a new FlatSQL script?
        for (const effect of transaction.effects) {
            // FlatSQL update effect?
            if (effect.is(UpdateFlatSQLScript)) {
                next = {
                    ...state,
                    ...effect.value,
                };

                // Entire script changed?
                if (state.mainScript !== next.mainScript || state.externalScript !== next.externalScript) {
                    return next;
                }
            }
        }

        // Did the document change?
        if (next.mainScript != null) {
            // Mirror all changes to the the FlatSQL script, if the script is != null.
            if (transaction.docChanged) {
                copyIfNotReplaced();
                transaction.changes.iterChanges(
                    (fromA: number, toA: number, fromB: number, toB: number, inserted: Text) => {
                        if (toA - fromA > 0) {
                            next.mainScript!.eraseTextRange(fromA, toA - fromA);
                        }
                        if (inserted.length > 0) {
                            let writer = fromB;
                            for (const text of inserted.iter()) {
                                next.mainScript!.insertTextAt(writer, text);
                                writer += text.length;
                            }
                        }
                    },
                );
                // Analyze the new script
                next.scriptBuffers = parseAndAnalyzeScript(next.mainScript!, next.externalScript);
                const cursorBuffer = next.mainScript!.moveCursor(selection ?? 0);
                next.scriptCursor = cursorBuffer.read(new flatsql.proto.ScriptCursorInfo()).unpack();
                cursorBuffer.delete();
                next.onUpdateScript(next.scriptKey, next.scriptBuffers, next.scriptCursor);
                return next;
            }
            // Update the script cursor
            if (cursorChanged) {
                copyIfNotReplaced();
                const cursorBuffer = next.mainScript!.moveCursor(selection ?? 0);
                next.scriptCursor = cursorBuffer.read(new flatsql.proto.ScriptCursorInfo()).unpack();
                cursorBuffer.delete();
                next.onUpdateScriptCursor(next.scriptKey, next.scriptCursor);
                return next;
            }
        }
        return next;
    },
});
