import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';

import { DecorationSet, EditorView } from '@codemirror/view';
import { ChangeSpec, StateEffect, EditorSelection } from '@codemirror/state';

import { CodeMirror } from './codemirror.js';
import { SQLynxExtensions } from './sqlynx_extension.js';
import { SQLynxScriptBuffers, SQLynxScriptKey, UpdateSQLynxScript } from './sqlynx_processor.js';
import { useAppConfig } from '../../app_config.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { UPDATE_SCRIPT_ANALYSIS, UPDATE_SCRIPT_CURSOR } from '../../session/session_state_reducer.js';
import { ScriptKey } from '../../session/session_state.js';
import { ScriptStatisticsBar } from './script_statistics_bar.js';
import { VerticalTabVariant, VerticalTabs } from '../../view/vertical_tabs.js';
import { classNames } from '../../utils/classnames.js';
import { useLogger } from '../../platform/logger_provider.js';

import * as icons from '../../../static/svg/symbols.generated.svg';

import * as styles from './editor.module.css';
import { isDebugBuild } from '../../globals.js';

enum TabId {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
    ACCOUNT = 3,
}

interface Props {
    className?: string;
}

interface ActiveScriptState {
    editorScriptVersion: number;
    editorScript: sqlynx.SQLynxScript | null;
    schemaScript: sqlynx.SQLynxScript | null;
    decorations: DecorationSet | null;
    cursor: sqlynx.proto.ScriptCursorInfoT | null;
}

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const logger = useLogger();
    const config = useAppConfig();
    const [ctx, ctxDispatch] = useCurrentSessionState();

    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.MAIN_SCRIPT);
    const [view, setView] = React.useState<EditorView | null>(null);

    const viewWasCreated = React.useCallback((view: EditorView) => setView(view), [setView]);
    const viewWillBeDestroyed = React.useCallback((_view: EditorView) => setView(null), [setView]);
    const active = React.useRef<ActiveScriptState>({
        editorScriptVersion: 0,
        editorScript: null,
        schemaScript: null,
        decorations: null,
        cursor: null,
    });
    const activeScriptKey = activeTab == TabId.SCHEMA_SCRIPT ? ScriptKey.SCHEMA_SCRIPT : ScriptKey.MAIN_SCRIPT;
    const activeScript = ctx?.scripts[activeScriptKey] ?? null;
    const activeScriptStatistics = activeScript?.statistics ?? null;
    const activeScriptFilename = activeScript?.metadata?.name ?? null;

    // Helper to update a script
    const updateScript = React.useCallback(
        (scriptKey: SQLynxScriptKey, buffers: SQLynxScriptBuffers, cursor: sqlynx.proto.ScriptCursorInfoT) => {
            active.current.cursor = cursor;
            ctxDispatch({
                type: UPDATE_SCRIPT_ANALYSIS,
                value: [scriptKey, buffers, cursor],
            });
        },
        [ctxDispatch],
    );
    // Helper to update a script cursor
    const updateScriptCursor = React.useCallback(
        (scriptKey: SQLynxScriptKey, cursor: sqlynx.proto.ScriptCursorInfoT) => {
            active.current.cursor = cursor;
            ctxDispatch({
                type: UPDATE_SCRIPT_CURSOR,
                value: [scriptKey, cursor],
            });
        },
        [ctxDispatch],
    );

    // Effect to update the editor context whenever the script changes
    React.useEffect(() => {
        // CodeMirror not set up yet?
        if (view === null) {
            return;
        }
        // Determine which script is active
        let targetKey: SQLynxScriptKey = ScriptKey.MAIN_SCRIPT;
        let schemaKey: SQLynxScriptKey | null = null;
        switch (activeTab as TabId) {
            case TabId.MAIN_SCRIPT:
                targetKey = ScriptKey.MAIN_SCRIPT;
                schemaKey = ScriptKey.SCHEMA_SCRIPT;
                break;
            case TabId.SCHEMA_SCRIPT:
                targetKey = ScriptKey.SCHEMA_SCRIPT;
                break;
        }
        const targetScriptData = ctx?.scripts[targetKey];
        const schemaScriptData = schemaKey != null ? ctx?.scripts[schemaKey] : null;
        const schemaScript = schemaScriptData?.script ?? null;
        if (!targetScriptData) {
            return;
        }

        // Did the script change?
        const changes: ChangeSpec[] = [];
        const effects: StateEffect<any>[] = [];
        if (
            active.current.editorScript !== targetScriptData.script ||
            active.current.editorScriptVersion !== targetScriptData.scriptVersion
        ) {
            logger.info("loading new script", "editor");
            active.current.editorScriptVersion = targetScriptData.scriptVersion;
            active.current.editorScript = targetScriptData.script;
            active.current.schemaScript = schemaScript;
            changes.push({
                from: 0,
                to: view.state.doc.length,
                insert: targetScriptData.script?.toString(),
            });
        } else if (active.current.schemaScript !== schemaScriptData?.script) {
            logger.info("skipping schema script update", "editor");
            // Only the external script changed, no need for text changes
            active.current.editorScriptVersion = targetScriptData.scriptVersion;
            active.current.editorScript = targetScriptData.script;
            active.current.schemaScript = schemaScript;
        }
        let selection: EditorSelection | null = null;
        if (active.current.cursor !== targetScriptData.cursor) {
            active.current.cursor = targetScriptData.cursor;
            selection = EditorSelection.create([EditorSelection.cursor(targetScriptData.cursor?.textOffset ?? 0)]);
        }
        effects.push(
            UpdateSQLynxScript.of({
                config: {
                    showCompletionDetails: config?.value?.features?.completionDetails ?? false,
                },
                scriptKey: targetKey,
                targetScriptVersion: targetScriptData.scriptVersion,
                targetScript: targetScriptData.script,
                scriptBuffers: targetScriptData.processed,
                scriptCursor: targetScriptData.cursor,
                focusedColumnRefs: ctx?.userFocus?.columnRefs ?? null,
                focusedTableRefs: ctx?.userFocus?.tableRefs ?? null,
                onUpdateScript: updateScript,
                onUpdateScriptCursor: updateScriptCursor,
            }),
        );
        view.dispatch({ changes, effects, selection: selection ?? undefined });
    }, [
        view,
        activeTab,
        ctx?.scripts[ScriptKey.MAIN_SCRIPT],
        ctx?.scripts[ScriptKey.SCHEMA_SCRIPT],
        ctx?.catalog,
        updateScript,
    ]);

    // Get the title of the tab
    let tabTitle = '';
    switch (activeTab) {
        case TabId.MAIN_SCRIPT:
            tabTitle = 'SQL Query';
            break;
        case TabId.SCHEMA_SCRIPT:
            tabTitle = 'SQL Schema';
            break;
        case TabId.ACCOUNT:
            tabTitle = 'Account';
            break;
    }

    const EditorPage = (
        <div className={styles.editor_with_header}>
            <div className={styles.headerbar}>
                <div className={styles.script_title}>{tabTitle}</div>
                <div className={styles.script_filename}>{activeScriptFilename ?? ""}</div>
            </div>
            <div className={styles.editor_with_loader}>
            <div className={styles.editor}>
                    <CodeMirror
                        extensions={SQLynxExtensions}
                        viewWasCreated={viewWasCreated}
                        viewWillBeDestroyed={viewWillBeDestroyed}
                    />
                </div>
            </div>
            {isDebugBuild() &&
                <div className={styles.devtools_overlay}>
                    <div className={styles.devtools_title}>
                        Editor Perf
                    </div>
                    <div className={styles.script_stats}>
                        <ScriptStatisticsBar stats={activeScriptStatistics} />
                    </div>
                </div>
            }
        </div>
    );

    return (
        <VerticalTabs
            variant={VerticalTabVariant.Stacked}
            className={classNames(props.className, styles.container)}
            selectedTab={activeTab}
            selectTab={setActiveTab}
            tabProps={{
                [TabId.MAIN_SCRIPT]: { tabId: TabId.MAIN_SCRIPT, icon: `${icons}#search`, labelShort: 'Query' },
                [TabId.SCHEMA_SCRIPT]: {
                    tabId: TabId.SCHEMA_SCRIPT,
                    icon: `${icons}#database`,
                    labelShort: 'Model',
                },
            }}
            tabKeys={[TabId.MAIN_SCRIPT, TabId.SCHEMA_SCRIPT]}
            tabRenderers={{
                [TabId.MAIN_SCRIPT]: () => EditorPage,
                [TabId.SCHEMA_SCRIPT]: () => EditorPage,
            }}
        />
    );
};
