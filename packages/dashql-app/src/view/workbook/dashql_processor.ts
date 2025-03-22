import * as dashql from '@ankoh/dashql-core';
import { StateField, StateEffect, StateEffectType, Text, Transaction } from '@codemirror/state';
import { completionStatus } from '@codemirror/autocomplete';
import { UserFocus } from '../../workbook/focus.js';

/// The configuration of the DashQL config
export interface DashQLProcessorConfig {
    showCompletionDetails: boolean;
}
/// A DashQL script key
export type DashQLScriptKey = number;
/// A DashQL script update
export interface DashQLScriptUpdate {
    // The config
    config: DashQLProcessorConfig;
    // The key of the currently active script
    scriptKey: DashQLScriptKey;
    // The currently active script in the editor
    targetScript: dashql.DashQLScript | null;
    /// The previous processed script buffers (if any)
    scriptBuffers: DashQLScriptBuffers;
    /// The script cursor
    scriptCursor: dashql.buffers.ScriptCursorT | null;
    /// The derive focus info
    derivedFocus: UserFocus | null;
    // This callback is called when the editor updates the script
    onScriptUpdate: (
        scriptKey: DashQLScriptKey,
        script: DashQLScriptBuffers,
        cursor: dashql.buffers.ScriptCursorT,
    ) => void;
    // This callback is called when the editor updates the cursor
    onCursorUpdate: (scriptKey: DashQLScriptKey, cursor: dashql.buffers.ScriptCursorT) => void;
    // This callback is called when the editor completion is starting
    onCompletionStart: (scriptKey: DashQLScriptKey, completion: dashql.buffers.CompletionT) => void;
    // This callback is called when the user peeks a completion candidate
    onCompletionPeek: (scriptKey: DashQLScriptKey, completion: dashql.buffers.CompletionT, candidateId: number) => void;
    // This callback is called when the editor completion is starting
    onCompletionStop: (scriptKey: DashQLScriptKey) => void;
}
/// The DashQL script buffers
export interface DashQLScriptBuffers {
    /// The scanned script
    scanned: dashql.FlatBufferPtr<dashql.buffers.ScannedScript> | null;
    /// The parsed script
    parsed: dashql.FlatBufferPtr<dashql.buffers.ParsedScript> | null;
    /// The analyzed script
    analyzed: dashql.FlatBufferPtr<dashql.buffers.AnalyzedScript> | null;
    /// Destroy the state.
    /// The user is responsible for cleanup up FlatBufferRefs that are no longer needed.
    /// E.g. one strategy may be to destroy the "old" state once a script with the same script key is emitted.
    destroy: (state: DashQLScriptBuffers) => void;
}
/// The state of a DashQL analyzer
export type DashQLEditorState = DashQLScriptUpdate & {
    completionStatus: null | "active" | "pending";
    completionActive: boolean;
};

/// Analyze a new script
export function parseAndAnalyzeScript(script: dashql.DashQLScript): DashQLScriptBuffers {
    // Scan the script
    const scanned = script.scan();
    // Parse the script
    const parsed = script.parse();
    // Analyze the script
    const analyzed = script.analyze();

    return { scanned, parsed, analyzed, destroy: destroyBuffers };
}

/// Analyze an existing script
export function analyzeScript(buffers: DashQLScriptBuffers, script: dashql.DashQLScript): DashQLScriptBuffers {
    // Delete the old analysis
    buffers.analyzed?.delete();
    // Analyze the script
    const analyzed = script.analyze();
    // Return the new script
    return { ...buffers, analyzed };
}

/// Destory the buffers
const destroyBuffers = (state: DashQLScriptBuffers) => {
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

/// Effect to update a DashQL script attached to a CodeMirror editor
export const UpdateDashQLScript: StateEffectType<DashQLScriptUpdate> = StateEffect.define<DashQLScriptUpdate>();

/// A processor for DashQL scripts
export const DashQLProcessor: StateField<DashQLEditorState> = StateField.define<DashQLEditorState>({
    // Create the initial state
    create: () => {
        // By default, the DashQL script is not configured
        const config: DashQLEditorState = {
            config: {
                showCompletionDetails: false,
            },
            scriptKey: 0,
            targetScript: null,
            scriptBuffers: {
                scanned: null,
                parsed: null,
                analyzed: null,
                destroy: destroyBuffers,
            },
            scriptCursor: null,
            derivedFocus: null,
            completionStatus: null,
            completionActive: false,
            onScriptUpdate: () => { },
            onCursorUpdate: () => { },
            onCompletionStart: () => { },
            onCompletionPeek: () => { },
            onCompletionStop: () => { },
        };
        return config;
    },
    // Mirror the DashQL state
    update: (state: DashQLEditorState, transaction: Transaction) => {
        // Did the selection change?
        const prevSelection = transaction.startState.selection.asSingle();
        const newSelection = transaction.newSelection.asSingle();
        const cursorChanged = !prevSelection.eq(newSelection);
        const selection: number | null = newSelection.main.to;
        let next: DashQLEditorState = state;

        // Helper to create a new state if it wasn't replaced
        const copyIfNotReplaced = () => {
            next = next === state ? { ...state } : next;
        };

        // Did the completion status change?
        const currentCompletionStatus = completionStatus(transaction.state);
        if (currentCompletionStatus != state.completionStatus) {
            copyIfNotReplaced();
            next.completionStatus = currentCompletionStatus;
            if (next.completionStatus == "active") {
                next.completionActive = true;
            } else if (next.completionStatus == null && state.completionActive) {
                next.completionActive = false;
                next.onCompletionStop(next.scriptKey);
            }
        }

        // Did the user provide us with a new DashQL script?
        for (const effect of transaction.effects) {
            // DashQL update effect?
            if (effect.is(UpdateDashQLScript)) {
                next = {
                    ...next,
                    ...effect.value,
                };

                // Script changed?
                // Signaled either through a completely new script or through a new script buffer
                if (
                    state.targetScript !== next.targetScript ||
                    state.scriptBuffers !== next.scriptBuffers
                ) {
                    return next;
                }
            }
        }

        if (next.targetScript != null) {
            // Mirror all changes to the the DashQL script, if the script is != null.
            if (transaction.docChanged) {
                copyIfNotReplaced();
                transaction.changes.iterChanges(
                    (fromA: number, toA: number, fromB: number, toB: number, inserted: Text) => {
                        if (toA - fromA > 0) {
                            next.targetScript!.eraseTextRange(fromA, toA - fromA);
                        }
                        if (inserted.length > 0) {
                            let writer = fromB;
                            for (const text of inserted.iter()) {
                                next.targetScript!.insertTextAt(writer, text);
                                writer += text.length;
                            }
                        }
                    },
                );
                // Analyze the new script
                next.scriptBuffers = parseAndAnalyzeScript(next.targetScript!);
                const cursorBuffer = next.targetScript!.moveCursor(selection ?? 0);
                next.scriptCursor = cursorBuffer.read().unpack();
                cursorBuffer.delete();
                // Watch out, this passes ownership over the script buffers
                next.onScriptUpdate(next.scriptKey, next.scriptBuffers, next.scriptCursor);
                return next;
            }
            // Update the script cursor..
            // This is the place where we handle events of normal cursor movements.
            if (cursorChanged) {
                copyIfNotReplaced();
                const cursorBuffer = next.targetScript!.moveCursor(selection ?? 0);
                next.scriptCursor = cursorBuffer.read().unpack();
                cursorBuffer.delete();
                next.onCursorUpdate(next.scriptKey, next.scriptCursor);
                return next;
            }
        }
        return next;
    },
});
