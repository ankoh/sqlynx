import cn from 'classnames';
import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import { DecorationSet, EditorView } from '@codemirror/view';
import { ChangeSpec, StateEffect, EditorSelection } from '@codemirror/state';

import { CodeMirror } from './codemirror';
import { FlatSQLExtensions } from './flatsql_extension';
import { FlatSQLScriptBuffers, FlatSQLScriptKey, UpdateFlatSQLScript } from './flatsql_processor';
import { useAppState, useAppStateDispatch } from '../state/app_state_provider';
import { UPDATE_SCRIPT_ANALYSIS, UPDATE_SCRIPT_CURSOR } from '../state/app_state_reducer';
import { ScriptKey } from '../state/app_state';
import { ScriptStatisticsBar } from './script_statistics_bar';

import iconMainScript from '../../static/svg/icons/database_search.svg';
import iconExternalScript from '../../static/svg/icons/database.svg';
import iconLoadExample from '../../static/svg/icons/folder_open.svg';
import iconStatistics from '../../static/svg/icons/speedometer.svg';
import iconChevronRight from '../../static/svg/icons/chevron_right.svg';
import iconAccount from '../../static/svg/icons/account_circle.svg';

import styles from './editor.module.css';
import { ScriptCursorInfoT } from '@ankoh/flatsql/dist/gen/flatsql/proto';

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
        className={cn(styles.navbar_tab, {
            [styles.navbar_tab_active]: props.id == props.active,
            [styles.navbar_tab_disabled]: props.disabled ?? false,
        })}
        onClick={props.onClick}
        data-tab={props.id}
    >
        <svg className={styles.button_icon} width="22px" height="22px">
            <use xlinkHref={`${props.icon}#sym`} />
        </svg>
    </div>
);

interface Props {}

interface ActiveScriptState {
    script: flatsql.FlatSQLScript | null;
    external: flatsql.FlatSQLScript | null;
    decorations: DecorationSet | null;
    cursor: ScriptCursorInfoT | null;
}

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const ctx = useAppState();
    const ctxDispatch = useAppStateDispatch();

    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.MAIN_SCRIPT);
    const [folderOpen, setFolderOpen] = React.useState<boolean>(false);
    const [statsOpen, setStatsOpen] = React.useState<boolean>(true);
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
        (scriptKey: FlatSQLScriptKey, buffers: FlatSQLScriptBuffers, cursor: flatsql.proto.ScriptCursorInfoT) => {
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
        (scriptKey: FlatSQLScriptKey, cursor: flatsql.proto.ScriptCursorInfoT) => {
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
        let mainKey: FlatSQLScriptKey = ScriptKey.MAIN_SCRIPT;
        let externalKey: FlatSQLScriptKey | null = null;
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
                UpdateFlatSQLScript.of({
                    scriptKey: mainKey,
                    mainScript: mainData.script,
                    externalScript: externalScript,
                    scriptBuffers: mainData.processed,
                    scriptCursor: mainData.cursor,
                    focusedColumnRefs: ctx.focus?.columnRefs ?? null,
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
            UpdateFlatSQLScript.of({
                scriptKey: mainKey,
                mainScript: mainData.script,
                externalScript: externalScript,
                scriptBuffers: mainData.processed,
                scriptCursor: mainData.cursor,
                focusedColumnRefs: ctx.focus?.columnRefs ?? null,
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
    const toggleOpenFolder = () => setFolderOpen(s => !s);
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
    return (
        <div className={styles.container}>
            <div className={styles.headerbar}>
                <div className={styles.script_title_container}>
                    <div className={styles.script_title}>{tabTitle}</div>
                </div>
                <div className={styles.script_statistics_container}>
                    <div
                        className={styles.script_statistics_button}
                        onClick={toggleOpenStats}
                        style={{
                            width: statsOpen ? '24px' : '40px',
                        }}
                    >
                        <svg className={styles.button_icon} width="20px" height="20px">
                            <use xlinkHref={`${statsOpen ? iconChevronRight : iconStatistics}#sym`} />
                        </svg>
                    </div>
                    {statsOpen && <ScriptStatisticsBar stats={activeScriptStatistics} />}
                </div>
                <div className={styles.example_loader_container}>
                    <div className={styles.example_loader_button} onClick={toggleOpenFolder}>
                        <svg className={styles.button_icon} width="20px" height="20px">
                            <use xlinkHref={`${iconLoadExample}#sym`} />
                        </svg>
                    </div>
                </div>
            </div>
            <div className={styles.navbar}>
                <Tab id={TabId.MAIN_SCRIPT} active={activeTab} icon={iconMainScript} onClick={selectTab} />
                <Tab id={TabId.SCHEMA_SCRIPT} active={activeTab} icon={iconExternalScript} onClick={selectTab} />
                <div style={{ flex: 1 }} />
                <Tab id={TabId.ACCOUNT} active={activeTab} icon={iconAccount} onClick={selectTab} disabled />
            </div>
            <div className={styles.editor_with_loader}>
                <div className={styles.editor}>
                    <CodeMirror
                        className={styles.codemirror}
                        extensions={FlatSQLExtensions}
                        viewWasCreated={viewWasCreated}
                        viewWillBeDestroyed={viewWillBeDestroyed}
                    />
                </div>
                <div className={styles.loader_container} style={{ display: folderOpen ? 'block' : 'none' }} />
            </div>
        </div>
    );
};
