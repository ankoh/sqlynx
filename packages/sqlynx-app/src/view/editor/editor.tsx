import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';
import * as themes from './themes/index.js';

import { lineNumbers } from '@codemirror/view';

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { EditorView, keymap } from '@codemirror/view';
import { ChangeSpec, EditorSelection, StateEffect } from '@codemirror/state';

import { CodeMirror } from './codemirror.js';
import { SQLynxExtensions } from './sqlynx_extension.js';
import { SQLynxScriptBuffers, SQLynxScriptKey, UpdateSQLynxScript } from './sqlynx_processor.js';
import { COMPLETION_CHANGED, COMPLETION_STARTED, COMPLETION_STOPPED, UPDATE_SCRIPT, UPDATE_SCRIPT_ANALYSIS, UPDATE_SCRIPT_CURSOR } from '../../session/session_state.js';
import { ScriptStatisticsBar } from './script_statistics_bar.js';
import { isDebugBuild } from '../../globals.js';
import { useAppConfig } from '../../app_config.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { useLogger } from '../../platform/logger_provider.js';

import * as styles from './editor.module.css';

interface Props {
    className?: string;
}

interface ActiveScriptState {
    script: sqlynx.SQLynxScript | null;
    scriptBuffers: SQLynxScriptBuffers | null;
    cursor: sqlynx.proto.ScriptCursorT | null;
}

export const ScriptEditor: React.FC<Props> = (_props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const [session, sessionDispatch] = useCurrentSessionState();

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
    const workbookEntryIdx = session?.selectedWorkbookEntry ?? 0;
    const workbookEntry = (workbookEntryIdx < (session?.workbookEntries.length ?? 0))
        ? session!.workbookEntries[workbookEntryIdx]
        : null;
    const workbookEntryScriptData = workbookEntry != null ? session!.scripts[workbookEntry.scriptKey] : null;


    // Helper to update a script.
    // Called when the script gets updated by the CodeMirror extension.
    const updateScript = React.useCallback(
        (scriptKey: SQLynxScriptKey, buffers: SQLynxScriptBuffers, cursor: sqlynx.proto.ScriptCursorT) => {
            active.current.cursor = cursor;
            active.current.scriptBuffers = buffers;
            sessionDispatch({
                type: UPDATE_SCRIPT_ANALYSIS,
                value: [scriptKey, buffers, cursor],
            });
        },
        [sessionDispatch],
    );
    // Helper to update a script cursor.
    // Called when the cursor gets updated by the CodeMirror extension.
    const updateCursor = React.useCallback(
        (scriptKey: SQLynxScriptKey, cursor: sqlynx.proto.ScriptCursorT) => {
            active.current.cursor = cursor;
            sessionDispatch({
                type: UPDATE_SCRIPT_CURSOR,
                value: [scriptKey, cursor],
            });
        },
        [sessionDispatch],
    );
    // Helper to start a completion.
    // Called when the CodeMirror extension opens the completion dropdown.
    const startCompletion = React.useCallback((scriptKey: SQLynxScriptKey, completion: sqlynx.proto.CompletionT) => {
        sessionDispatch({
            type: COMPLETION_STARTED,
            value: [scriptKey, completion],
        });
    }, []);
    // Helper to peek a completion candidate
    // Called when the CodeMirror extension changes the selected completion.
    const peekCompletionCandidate = React.useCallback((scriptKey: SQLynxScriptKey, completion: sqlynx.proto.CompletionT, candidateId: number) => {
        sessionDispatch({
            type: COMPLETION_CHANGED,
            value: [scriptKey, completion, candidateId],
        });
    }, []);
    // Helper to stop a completion.
    // Called when the CodeMirror extension opens the completion dropdown.
    const stopCompletion = React.useCallback((scriptKey: SQLynxScriptKey) => {
        sessionDispatch({
            type: COMPLETION_STOPPED,
            value: scriptKey,
        });
    }, []);

    // Effect to update outdated scripts
    React.useEffect(() => {
        if (workbookEntryScriptData?.outdatedAnalysis) {
            sessionDispatch({
                type: UPDATE_SCRIPT,
                value: workbookEntryScriptData.scriptKey
            });
        }
    }, [workbookEntryScriptData]);

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
            logger.info("loading new script", "editor");
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
            UpdateSQLynxScript.of({
                config: {
                    showCompletionDetails: config?.value?.settings?.showCompletionDetails ?? false,
                },
                scriptKey: workbookEntryScriptData.scriptKey,
                targetScript: workbookEntryScriptData.script,
                scriptBuffers: workbookEntryScriptData.processed,
                scriptCursor: workbookEntryScriptData.cursor,
                derivedFocus: session?.userFocus ?? null,

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
        session?.connectionCatalog,
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
            ...SQLynxExtensions,
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
