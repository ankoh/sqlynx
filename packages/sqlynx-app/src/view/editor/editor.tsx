import cn from 'classnames';

import * as React from 'react';
import * as sqlynx from '@ankoh/sqlynx';

import { IconButton } from '@primer/react';
import { DecorationSet, EditorView } from '@codemirror/view';
import { ChangeSpec, StateEffect, EditorSelection } from '@codemirror/state';

import { CodeMirror } from './codemirror';
import { SQLynxExtensions } from './sqlynx_extension';
import { SQLynxScriptBuffers, SQLynxScriptKey, UpdateSQLynxScript } from './sqlynx_processor';
import { useAppConfig } from '../../state/app_config';
import { useAppState, useAppStateDispatch } from '../../state/app_state_provider';
import { UPDATE_SCRIPT_ANALYSIS, UPDATE_SCRIPT_CURSOR } from '../../state/app_state_reducer';
import { ScriptKey } from '../../state/app_state';
import { ScriptStatisticsBar } from './script_statistics_bar';

import icons from '../../../static/svg/symbols.generated.svg';

import styles from './editor.module.css';
import { ScriptCursorInfoT } from '@ankoh/sqlynx/dist/gen/sqlynx/proto';

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
    script: sqlynx.SQLynxScript | null;
    external: sqlynx.SQLynxScript | null;
    decorations: DecorationSet | null;
    cursor: ScriptCursorInfoT | null;
}

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const ctx = useAppState();
    const ctxDispatch = useAppStateDispatch();
    const config = useAppConfig();

    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.MAIN_SCRIPT);
    const [statsOpen, setStatsOpen] = React.useState<boolean>(false);
    const [view, setView] = React.useState<EditorView | null>(null);

    const viewWasCreated = React.useCallback((view: EditorView) => setView(view), [setView]);
    const viewWillBeDestroyed = React.useCallback((view: EditorView) => setView(null), [setView]);
    const active = React.useRef<ActiveScriptState>({
        script: null,
        external: null,
        decorations: null,
        cursor: null,
    });
    const activeScriptKey = activeTab == TabId.SCHEMA_SCRIPT ? ScriptKey.SCHEMA_SCRIPT : ScriptKey.MAIN_SCRIPT;
    const activeScriptStatistics = ctx.scripts[activeScriptKey].statistics;

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
        let mainKey: SQLynxScriptKey = ScriptKey.MAIN_SCRIPT;
        let externalKey: SQLynxScriptKey | null = null;
        switch (activeTab as TabId) {
            case TabId.MAIN_SCRIPT:
                mainKey = ScriptKey.MAIN_SCRIPT;
                externalKey = ScriptKey.SCHEMA_SCRIPT;
                break;
            case TabId.SCHEMA_SCRIPT:
                mainKey = ScriptKey.SCHEMA_SCRIPT;
                break;
        }
        const mainData = ctx.scripts[mainKey];
        const externalData = externalKey != null ? ctx.scripts[externalKey] : null;
        const externalScript = externalData?.script ?? null;

        // Did the script change?
        const changes: ChangeSpec[] = [];
        const effects: StateEffect<any>[] = [];
        if (active.current.script !== mainData.script) {
            active.current.script = mainData.script;
            active.current.external = externalScript;
            changes.push({
                from: 0,
                to: view.state.doc.length,
                insert: mainData.script?.toString(),
            });
            effects.push(
                UpdateSQLynxScript.of({
                    config: {
                        showCompletionDetails: config?.value?.features?.completionDetails ?? false,
                    },
                    scriptKey: mainKey,
                    mainScript: mainData.script,
                    externalScript: externalScript,
                    scriptBuffers: mainData.processed,
                    scriptCursor: mainData.cursor,
                    focusedColumnRefs: ctx.focus?.columnRefs ?? null,
                    focusedTableRefs: ctx.focus?.tableRefs ?? null,
                    onUpdateScript: updateScript,
                    onUpdateScriptCursor: updateScriptCursor,
                }),
            );
        } else if (active.current.external !== externalData?.script) {
            // Only the external script changed, no need for text changes
            active.current.script = mainData.script;
            active.current.external = externalScript;
        }
        effects.push(
            UpdateSQLynxScript.of({
                config: {
                    showCompletionDetails: config?.value?.features?.completionDetails ?? false,
                },
                scriptKey: mainKey,
                mainScript: mainData.script,
                externalScript: externalScript,
                scriptBuffers: mainData.processed,
                scriptCursor: mainData.cursor,
                focusedColumnRefs: ctx.focus?.columnRefs ?? null,
                focusedTableRefs: ctx.focus?.tableRefs ?? null,
                onUpdateScript: updateScript,
                onUpdateScriptCursor: updateScriptCursor,
            }),
        );
        let selection: EditorSelection | null = null;
        if (active.current.cursor !== mainData.cursor) {
            active.current.cursor = mainData.cursor;
            selection = EditorSelection.create([EditorSelection.cursor(mainData.cursor?.textOffset ?? 0)]);
        }
        if (changes.length > 0 || effects.length > 0 || selection !== null) {
            view.dispatch({ changes, effects, selection: selection ?? undefined });
        }
    }, [view, activeTab, ctx.scripts[ScriptKey.MAIN_SCRIPT], ctx.scripts[ScriptKey.SCHEMA_SCRIPT], updateScript]);

    // Helper to select a tab
    const selectTab = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const tab = (event.target as any).getAttribute('data-tab') as TabId;
        setActiveTab(+tab);
    };
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

    return (
        <div className={cn(props.className, styles.container)}>
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
                    {statsOpen && <ScriptStatisticsBar stats={activeScriptStatistics} />}
                </div>
            </div>
            <div className={styles.tabs}>
                <Tab id={TabId.MAIN_SCRIPT} active={activeTab} icon={`${icons}#database_search`} onClick={selectTab} />
                <Tab id={TabId.SCHEMA_SCRIPT} active={activeTab} icon={`${icons}#table_multiple`} onClick={selectTab} />
                <div style={{ flex: 1 }} />
                <Tab
                    id={TabId.ACCOUNT}
                    active={activeTab}
                    icon={`${icons}#account_circle`}
                    onClick={selectTab}
                    disabled
                />
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
};
