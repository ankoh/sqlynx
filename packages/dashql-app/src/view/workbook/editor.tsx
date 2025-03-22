import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from './editor.module.css';
import * as themes from './themes/index.js';

import { lineNumbers } from '@codemirror/view';

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { EditorView, keymap } from '@codemirror/view';
import { ChangeSpec, EditorSelection, StateEffect } from '@codemirror/state';

import { CodeMirror } from './codemirror.js';
import { DashQLExtensions } from './dashql_extension.js';
import { DashQLScriptBuffers, DashQLScriptKey, UpdateDashQLScript } from './dashql_processor.js';
import { COMPLETION_CHANGED, COMPLETION_STARTED, COMPLETION_STOPPED, UPDATE_SCRIPT, UPDATE_SCRIPT_ANALYSIS, UPDATE_SCRIPT_CURSOR } from '../../workbook/workbook_state.js';
import { ScriptStatisticsBar } from './script_statistics_bar.js';
import { isDebugBuild } from '../../globals.js';
import { useAppConfig } from '../../app_config.js';
import { useCurrentWorkbookState } from '../../workbook/current_workbook.js';
import { useLogger } from '../../platform/logger_provider.js';
import { useConnectionState } from '../../connection/connection_registry.js';
import { refreshCatalogOnce } from '../../connection/catalog_loader.js';

interface Props {
    className?: string;
}

interface ActiveScriptState {
    script: dashql.DashQLScript | null;
    scriptBuffers: DashQLScriptBuffers | null;
    cursor: dashql.buffers.ScriptCursorT | null;
}

export const ScriptEditor: React.FC<Props> = (_props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const [workbook, modifyWorkbook] = useCurrentWorkbookState();
    const [connState, _modifyConn] = useConnectionState(workbook?.connectionId ?? null);

    // The editor view
    const [view, setView] = React.useState<EditorView | null>(null);
    const viewWasCreated = React.useCallback((view: EditorView) => setView(view), [setView]);
    const viewWillBeDestroyed = React.useCallback((_view: EditorView) => setView(null), [setView]);
    const active = React.useRef<ActiveScriptState>({
        script: null,
        scriptBuffers: null,
        cursor: null,
    });

    // The current index in the workbook
    const workbookEntryIdx = workbook?.selectedWorkbookEntry ?? 0;
    const workbookEntry = (workbookEntryIdx < (workbook?.workbookEntries.length ?? 0))
        ? workbook!.workbookEntries[workbookEntryIdx]
        : null;
    const workbookEntryScriptData = workbookEntry != null ? workbook!.scripts[workbookEntry.scriptKey] : null;

    // Effect to refresh the connection catalog for the active script
    // if it hasn't been refreshed yet.
    refreshCatalogOnce(connState);

    // Update outdated scripts that are displayed in the editor
    React.useEffect(() => {
        if (workbookEntryScriptData?.outdatedAnalysis) {
            modifyWorkbook({
                type: UPDATE_SCRIPT,
                value: workbookEntryScriptData.scriptKey
            });
        }
    }, [workbookEntryScriptData]);

    // Helper to update a script.
    // Called when the script gets updated by the CodeMirror extension.
    const updateScript = React.useCallback(
        (scriptKey: DashQLScriptKey, buffers: DashQLScriptBuffers, cursor: dashql.buffers.ScriptCursorT) => {
            active.current.cursor = cursor;
            active.current.scriptBuffers = buffers;
            modifyWorkbook({
                type: UPDATE_SCRIPT_ANALYSIS,
                value: [scriptKey, buffers, cursor],
            });
        },
        [modifyWorkbook],
    );
    // Helper to update a script cursor.
    // Called when the cursor gets updated by the CodeMirror extension.
    const updateCursor = React.useCallback(
        (scriptKey: DashQLScriptKey, cursor: dashql.buffers.ScriptCursorT) => {
            active.current.cursor = cursor;
            modifyWorkbook({
                type: UPDATE_SCRIPT_CURSOR,
                value: [scriptKey, cursor],
            });
        },
        [modifyWorkbook],
    );
    // Helper to start a completion.
    // Called when the CodeMirror extension opens the completion dropdown.
    const startCompletion = React.useCallback((scriptKey: DashQLScriptKey, completion: dashql.buffers.CompletionT) => {
        modifyWorkbook({
            type: COMPLETION_STARTED,
            value: [scriptKey, completion],
        });
    }, []);
    // Helper to peek a completion candidate
    // Called when the CodeMirror extension changes the selected completion.
    const peekCompletionCandidate = React.useCallback((scriptKey: DashQLScriptKey, completion: dashql.buffers.CompletionT, candidateId: number) => {
        modifyWorkbook({
            type: COMPLETION_CHANGED,
            value: [scriptKey, completion, candidateId],
        });
    }, []);
    // Helper to stop a completion.
    // Called when the CodeMirror extension opens the completion dropdown.
    const stopCompletion = React.useCallback((scriptKey: DashQLScriptKey) => {
        modifyWorkbook({
            type: COMPLETION_STOPPED,
            value: scriptKey,
        });
    }, []);

    // Effect to update the editor context whenever the script changes
    React.useEffect(() => {
        // CodeMirror not set up yet?
        if (view === null) {
            return;
        }
        // No script data?
        if (!workbookEntryScriptData) {
            return
        }

        // Did the script change?
        const changes: ChangeSpec[] = [];
        const effects: StateEffect<any>[] = [];
        if (
            active.current.script !== workbookEntryScriptData.script ||
            active.current.scriptBuffers !== workbookEntryScriptData.processed
        ) {
            logger.info("loading new script", {}, "editor");
            active.current.script = workbookEntryScriptData.script;
            active.current.scriptBuffers = workbookEntryScriptData.processed;
            changes.push({
                from: 0,
                to: view.state.doc.length,
                insert: workbookEntryScriptData.script?.toString(),
            });
        }

        // Did the cursor change?
        let selection: EditorSelection | null = null;
        if (active.current.cursor !== workbookEntryScriptData.cursor) {
            active.current.cursor = workbookEntryScriptData.cursor;
            selection = EditorSelection.create([EditorSelection.cursor(workbookEntryScriptData.cursor?.textOffset ?? 0)]);
        }

        // Notify the CodeMirror extension
        effects.push(
            UpdateDashQLScript.of({
                config: {
                    showCompletionDetails: config?.value?.settings?.showCompletionDetails ?? false,
                },
                scriptKey: workbookEntryScriptData.scriptKey,
                targetScript: workbookEntryScriptData.script,
                scriptBuffers: workbookEntryScriptData.processed,
                scriptCursor: workbookEntryScriptData.cursor,
                derivedFocus: workbook?.userFocus ?? null,

                onScriptUpdate: updateScript,
                onCursorUpdate: updateCursor,
                onCompletionStart: startCompletion,
                onCompletionPeek: peekCompletionCandidate,
                onCompletionStop: stopCompletion,
            }),
        );
        view.dispatch({ changes, effects, selection: selection ?? undefined });
    }, [
        view,
        workbookEntryIdx,
        workbookEntryScriptData,
        workbook?.connectionCatalog,
        updateScript,
    ]);

    // See: https://github.com/codemirror/basic-setup/blob/main/src/codemirror.ts
    // We might want to add other plugins later.
    const extensions = React.useMemo(() => {
        /* XXX ANY CAST IS A HACK. Need to update @codemirror/view */
        const keymapExtension = keymap.of([
            ...defaultKeymap as any,
            ...historyKeymap
        ]);
        return [
            themes.xcode.xcodeLight,
            lineNumbers(),
            history(),
            ...DashQLExtensions,
            keymapExtension
        ];
    }, []);

    return (
        <div className={styles.editor_with_header}>
            <div className={styles.headerbar}>
                <div className={styles.script_title}>{workbookEntry?.title ?? "Script"}</div>
            </div>
            <div className={styles.editor_with_loader}>
                <div className={styles.editor}>
                    <CodeMirror
                        extensions={extensions}
                        viewWasCreated={viewWasCreated}
                        viewWillBeDestroyed={viewWillBeDestroyed}
                    />
                </div>
            </div>
            {isDebugBuild() && config?.value?.settings?.showEditorStats && workbookEntryScriptData?.statistics &&
                <div className={styles.devtools_overlay}>
                    <div className={styles.devtools_title}>
                        Editor Perf
                    </div>
                    <div className={styles.script_stats}>
                        <ScriptStatisticsBar stats={workbookEntryScriptData.statistics} />
                    </div>
                </div>
            }
        </div>
    );
};
