import cn from 'classnames';

import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx-core';

import { IconButton } from '@primer/react';
import { DecorationSet, EditorView } from '@codemirror/view';
import { ChangeSpec, StateEffect, EditorSelection } from '@codemirror/state';

import { CodeMirror } from './codemirror';
import { SQLynxExtensions } from './sqlynx_extension';
import { SQLynxScriptBuffers, SQLynxScriptKey, UpdateSQLynxScript } from './sqlynx_processor';
import { useAppConfig } from '../../app_config';
import { useSelectedScriptState, useSelectedScriptStateDispatch } from '../../scripts/script_state_provider';
import { UPDATE_SCRIPT_ANALYSIS, UPDATE_SCRIPT_CURSOR } from '../../scripts/script_state_reducer';
import { ScriptKey } from '../../scripts/script_state';
import { ScriptStatisticsBar } from './script_statistics_bar';
import { VerticalTabs } from '../../view/vertical_tabs';

import icons from '../../../static/svg/symbols.generated.svg';

import styles from './editor.module.css';

enum TabId {
    MAIN_SCRIPT = 1,
    SCHEMA_SCRIPT = 2,
    ACCOUNT = 3,
}

interface TabProps {
    id: TabId;
    active: TabId;
    icon: string;
    disabled?: boolean;
    onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const Tab: React.FC<TabProps> = (props: TabProps) => (
    <div
        className={cn(styles.tab, {
            [styles.tab_active]: props.id == props.active,
            [styles.tab_disabled]: props.disabled ?? false,
        })}
        onClick={props.onClick}
        data-tab={props.id}
    >
        <svg className={styles.button_icon} width="20px" height="20px">
            <use xlinkHref={props.icon} />
        </svg>
    </div>
);

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
    const ctx = useSelectedScriptState();
    const ctxDispatch = useSelectedScriptStateDispatch();
    const config = useAppConfig();

    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.MAIN_SCRIPT);
    const [statsOpen, setStatsOpen] = React.useState<boolean>(false);
    const [view, setView] = React.useState<EditorView | null>(null);

    const viewWasCreated = React.useCallback((view: EditorView) => setView(view), [setView]);
    const viewWillBeDestroyed = React.useCallback((view: EditorView) => setView(null), [setView]);
    const active = React.useRef<ActiveScriptState>({
        editorScriptVersion: 0,
        editorScript: null,
        schemaScript: null,
        decorations: null,
        cursor: null,
    });
    const activeScriptKey = activeTab == TabId.SCHEMA_SCRIPT ? ScriptKey.SCHEMA_SCRIPT : ScriptKey.MAIN_SCRIPT;
    const activeScriptStatistics = ctx?.scripts[activeScriptKey]?.statistics ?? null;

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
            active.current.editorScriptVersion = targetScriptData.scriptVersion;
            active.current.editorScript = targetScriptData.script;
            active.current.schemaScript = schemaScript;
            changes.push({
                from: 0,
                to: view.state.doc.length,
                insert: targetScriptData.script?.toString(),
            });
        } else if (active.current.schemaScript !== schemaScriptData?.script) {
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

    // Helper to toggle the folder and stats
    const toggleOpenStats = () => setStatsOpen(s => !s);
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

    const StatsIcon: React.ElementType<any> = () => (
        <svg className={styles.button_icon} width="20px" height="20px">
            <use xlinkHref={`${icons}${statsOpen ? '#chevron_right' : '#speedometer'}`} />
        </svg>
    );

    const EditorPage = (
        <div className={styles.editor_with_header}>
            <div className={styles.headerbar}>
                <div className={styles.script_title_container}>
                    <div className={styles.script_title}>{tabTitle}</div>
                </div>
                <div className={styles.script_statistics_container}>
                    <IconButton
                        className={styles.script_statistics_toggle}
                        variant="invisible"
                        icon={StatsIcon}
                        aria-labelledby="stats"
                        onClick={toggleOpenStats}
                    />
                    {activeScriptStatistics && statsOpen && <ScriptStatisticsBar stats={activeScriptStatistics} />}
                </div>
            </div>
            <div className={styles.editor_with_loader}>
                <div className={styles.editor}>
                    <CodeMirror
                        className={styles.codemirror}
                        extensions={SQLynxExtensions}
                        viewWasCreated={viewWasCreated}
                        viewWillBeDestroyed={viewWillBeDestroyed}
                    />
                </div>
            </div>
        </div>
    );

    return (
        <VerticalTabs
            className={cn(props.className, styles.container)}
            selectedTab={activeTab}
            selectTab={setActiveTab}
            tabs={[
                { tabId: TabId.MAIN_SCRIPT, icon: `${icons}#database_search`, label: 'Query', enabled: true },
                {
                    tabId: TabId.SCHEMA_SCRIPT,
                    icon: `${icons}#database`,
                    label: 'Model',
                    enabled: true,
                },
            ]}
            tabRenderers={{
                [TabId.MAIN_SCRIPT]: () => EditorPage,
                [TabId.SCHEMA_SCRIPT]: () => EditorPage,
            }}
        />
    );
};
