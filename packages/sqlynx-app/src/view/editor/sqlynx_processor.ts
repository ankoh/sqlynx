import * as sqlynx from '@ankoh/sqlynx';
import { StateField, StateEffect, StateEffectType, Text, Transaction } from '@codemirror/state';

/// A SQLynx script key
export type SQLynxScriptKey = number;
/// A SQLynx script update
export interface SQLynxScriptUpdate {
    // The key of the currently active script
    scriptKey: SQLynxScriptKey;
    // The currently active script in the editor
    mainScript: sqlynx.SQLynxScript | null;
    // The second script
    externalScript: sqlynx.SQLynxScript | null;
    /// The previous processed script buffers (if any)
    scriptBuffers: SQLynxScriptBuffers;
    /// The script cursor
    scriptCursor: sqlynx.proto.ScriptCursorInfoT | null;
    /// The focused column references
    focusedColumnRefs: Set<sqlynx.QualifiedID.Value> | null;
    /// The focused table references
    focusedTableRefs: Set<sqlynx.QualifiedID.Value> | null;
    // This callback is called when the editor updates the script
    onUpdateScript: (
        scriptKey: SQLynxScriptKey,
        script: SQLynxScriptBuffers,
        cursor: sqlynx.proto.ScriptCursorInfoT,
    ) => void;
    // This callback is called when the editor updates the cursor
    onUpdateScriptCursor: (scriptKey: SQLynxScriptKey, cursor: sqlynx.proto.ScriptCursorInfoT) => void;
}
/// The SQLynx script buffers
export interface SQLynxScriptBuffers {
    /// The scanned script
    scanned: sqlynx.FlatBufferRef<sqlynx.proto.ScannedScript> | null;
    /// The parsed script
    parsed: sqlynx.FlatBufferRef<sqlynx.proto.ParsedScript> | null;
    /// The analyzed script
    analyzed: sqlynx.FlatBufferRef<sqlynx.proto.AnalyzedScript> | null;
    /// Destroy the state.
    /// The user is responsible for cleanup up FlatBufferRefs that are no longer needed.
    /// E.g. one strategy may be to destroy the "old" state once a script with the same script key is emitted.
    destroy: (state: SQLynxScriptBuffers) => void;
}
/// The state of a SQLynx analyzer
type SQLynxEditorState = SQLynxScriptUpdate;

/// Analyze a new script
export function parseAndAnalyzeScript(
    script: sqlynx.SQLynxScript,
    external: sqlynx.SQLynxScript | null,
): SQLynxScriptBuffers {
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
    buffers: SQLynxScriptBuffers,
    script: sqlynx.SQLynxScript,
    external: sqlynx.SQLynxScript | null,
): SQLynxScriptBuffers {
    // Delete the old analysis
    buffers.analyzed?.delete();
    // Analyze the script
    const analyzed = script.analyze(external);
    // Return the new script
    return { ...buffers, analyzed };
}

/// Destory the buffers
const destroyBuffers = (state: SQLynxScriptBuffers) => {
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

/// Effect to update a SQLynx script attached to a CodeMirror editor
export const UpdateSQLynxScript: StateEffectType<SQLynxScriptUpdate> = StateEffect.define<SQLynxScriptUpdate>();

/// A processor for SQLynx scripts
export const SQLynxProcessor: StateField<SQLynxEditorState> = StateField.define<SQLynxEditorState>({
    // Create the initial state
    create: () => {
        // By default, the SQLynx script is not configured
        const config: SQLynxEditorState = {
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
    // Mirror the SQLynx state
    update: (state: SQLynxEditorState, transaction: Transaction) => {
        // Did the selection change?
        const prevSelection = transaction.startState.selection.asSingle();
        const newSelection = transaction.newSelection.asSingle();
        const cursorChanged = !prevSelection.eq(newSelection);
        let selection: number | null = newSelection.main.to;
        let next: SQLynxEditorState = state;

        const copyIfNotReplaced = () => {
            next = next === state ? { ...state } : state;
        };

        // Did the user provide us with a new SQLynx script?
        for (const effect of transaction.effects) {
            // SQLynx update effect?
            if (effect.is(UpdateSQLynxScript)) {
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
            // Mirror all changes to the the SQLynx script, if the script is != null.
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
                next.scriptCursor = cursorBuffer.read(new sqlynx.proto.ScriptCursorInfo()).unpack();
                cursorBuffer.delete();
                next.onUpdateScript(next.scriptKey, next.scriptBuffers, next.scriptCursor);
                return next;
            }
            // Update the script cursor
            if (cursorChanged) {
                copyIfNotReplaced();
                const cursorBuffer = next.mainScript!.moveCursor(selection ?? 0);
                next.scriptCursor = cursorBuffer.read(new sqlynx.proto.ScriptCursorInfo()).unpack();
                cursorBuffer.delete();
                next.onUpdateScriptCursor(next.scriptKey, next.scriptCursor);
                return next;
            }
        }
        return next;
    },
});
