import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import cn from 'classnames';

import { Decoration, DecorationSet, EditorView, lineNumbers } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { CodeMirror } from './codemirror';
import { UpdateFlatSQLDecorations, UpdateFlatSQLScript, FlatSQLExtensions } from './extension';
import { useFlatSQLState, useFlatSQLDispatch, UPDATE_SCRIPT } from '../flatsql_state';

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
    onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const Tab: React.FC<TabProps> = (props: TabProps) => (
    <div
        className={cn(styles.navbar_tab, {
            [styles.navbar_tab_active]: props.id == props.active,
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
    const ctx = useFlatSQLState();
    const ctxDispatch = useFlatSQLDispatch();
    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.MAIN_SCRIPT);
    const [folderOpen, setFolderOpen] = React.useState<boolean>(false);
    const [view, setView] = React.useState<EditorView | null>(null);

    const viewWasCreated = React.useCallback((view: EditorView) => setView(view), [setView]);
    const viewWillBeDestroyed = React.useCallback((view: EditorView) => setView(null), [setView]);
    const activeScript = React.useRef<ActiveScriptState>({
        script: null,
        decorations: null,
    });
    const updateScript = React.useCallback(
        (script: flatsql.FlatSQLScript) => {
            ctxDispatch({
                type: UPDATE_SCRIPT,
                value: script,
            });
        },
        [ctxDispatch],
    );
    React.useEffect(() => {
        // CodeMirror not set up yet?
        if (view === null) {
            return;
        }
        // Determine which script is active
        let script: flatsql.FlatSQLScript | null = activeScript.current.script;
        let decorations: DecorationSet | null = activeScript.current.decorations;

        switch (activeTab as TabId) {
            case TabId.ACCOUNT:
                break;
            case TabId.MAIN_SCRIPT: {
                script = ctx.mainScript;
                decorations = ctx.mainDecorations;
                break;
            }
            case TabId.SCHEMA_SCRIPT: {
                script = ctx.schemaScript;
                decorations = null;
                break;
            }
        }

        // Did the script change?
        let changes = [];
        let effects = [];
        if (activeScript.current.script !== script) {
            changes.push({
                from: 0,
                to: view.state.doc.length,
                insert: script?.toString(),
            });
            effects.push(
                UpdateFlatSQLScript.of({
                    script,
                    onChange: updateScript,
                }),
            );
            activeScript.current.script = script;
        }
        // Did the decorations change?
        if (activeScript.current.decorations !== decorations) {
            effects.push(UpdateFlatSQLDecorations.of(decorations ?? new RangeSetBuilder<Decoration>().finish()));
            activeScript.current.decorations = decorations;
        }
        // Did anything change? Then update the view
        if (changes.length > 0 || effects.length > 0) {
            view.dispatch({ changes, effects });
        }
    }, [view, activeTab, ctx.schemaScript, ctx.mainScript, ctx.mainDecorations, updateScript]);

    // Helper to select a tab
    const selectTab = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const tab = (event.target as any).getAttribute('data-tab') as TabId;
        setActiveTab(+tab);
    };
    // Helper to toggle the folder viewer
    const toggleOpenFolder = () => setFolderOpen(s => !s);

    return (
        <div className={styles.container}>
            <div className={styles.headerbar}>
                <div className={styles.headerbar_left}>
                    <div className={styles.headerbar_script_title}>SQL Schema</div>
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
                <Tab id={TabId.ACCOUNT} active={activeTab} icon={iconAccount} onClick={selectTab} />
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
