import cn from 'classnames';
import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import { DecorationSet, EditorView } from '@codemirror/view';

import { CodeMirror } from './codemirror';
import { FlatSQLExtensions } from './flatsql_extension';
import { FlatSQLScriptKey, UpdateFlatSQLScript, analyzeScript } from './flatsql_analyzer';
import { useAppState, useAppStateDispatch, UPDATE_SCRIPT_ANALYSIS, LOAD_SCRIPTS } from '../app_state_reducer';
import { ScriptKey } from '../app_state';
import { TPCH_SCHEMA, exampleScripts } from '../script_loader/example_scripts';

import iconMainScript from '../../static/svg/icons/database_search.svg';
import iconExternalScript from '../../static/svg/icons/database.svg';
import iconLoadExample from '../../static/svg/icons/folder_open.svg';
import iconAccount from '../../static/svg/icons/account_circle.svg';

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
    decorations: DecorationSet | null;
}

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const ctx = useAppState();
    const ctxDispatch = useAppStateDispatch();
    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.SCHEMA_SCRIPT);
    const [folderOpen, setFolderOpen] = React.useState<boolean>(false);
    const [view, setView] = React.useState<EditorView | null>(null);

    const viewWasCreated = React.useCallback((view: EditorView) => setView(view), [setView]);
    const viewWillBeDestroyed = React.useCallback((view: EditorView) => setView(null), [setView]);
    const activeScript = React.useRef<ActiveScriptState>({
        script: null,
        decorations: null,
    });

    React.useEffect(() => {
        if (ctx.instance) {
            ctxDispatch({
                type: LOAD_SCRIPTS,
                value: {
                    [ScriptKey.MAIN_SCRIPT]: exampleScripts[2],
                    [ScriptKey.SCHEMA_SCRIPT]: TPCH_SCHEMA,
                },
            });
        }
    }, [ctx.instance]);

    // Helper to update a script
    const updateScript = React.useCallback(
        (scriptKey: FlatSQLScriptKey, script: flatsql.FlatSQLScript) => {
            // Analyze the script
            const data = analyzeScript(script);
            ctxDispatch({
                type: UPDATE_SCRIPT_ANALYSIS,
                value: [scriptKey, data],
            });
            return data;
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
        let scriptKey: FlatSQLScriptKey = ScriptKey.MAIN_SCRIPT;
        switch (activeTab as TabId) {
            case TabId.MAIN_SCRIPT:
                scriptKey = ScriptKey.MAIN_SCRIPT;
                break;
            case TabId.SCHEMA_SCRIPT:
                scriptKey = ScriptKey.SCHEMA_SCRIPT;
                break;
        }
        const scriptData = ctx.scripts[scriptKey];

        // Did the script change?
        if (activeScript.current.script !== scriptData.script) {
            activeScript.current.script = scriptData.script;
            view.dispatch({
                changes: [
                    {
                        from: 0,
                        to: view.state.doc.length,
                        insert: scriptData.script?.toString(),
                    },
                ],
                effects: [
                    UpdateFlatSQLScript.of({
                        scriptKey,
                        script: scriptData.script,
                        data: scriptData.analysis,
                        update: updateScript,
                    }),
                ],
            });
        }
    }, [view, activeTab, ctx.scripts[ScriptKey.MAIN_SCRIPT], ctx.scripts[ScriptKey.SCHEMA_SCRIPT], updateScript]);

    // Helper to select a tab
    const selectTab = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const tab = (event.target as any).getAttribute('data-tab') as TabId;
        setActiveTab(+tab);
    };
    // Helper to toggle the folder viewer
    const toggleOpenFolder = () => setFolderOpen(s => !s);
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
                <div className={styles.headerbar_left}>
                    <div className={styles.headerbar_script_title}>{tabTitle}</div>
                </div>
                <div className={styles.headerbar_right}>
                    <div className={styles.example_loader_container}>
                        <div className={styles.example_loader_button} onClick={toggleOpenFolder}>
                            <svg className={styles.button_icon} width="20px" height="20px">
                                <use xlinkHref={`${iconLoadExample}#sym`} />
                            </svg>
                        </div>
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
