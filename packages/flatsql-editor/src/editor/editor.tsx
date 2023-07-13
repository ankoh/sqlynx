import * as React from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import cn from 'classnames';

import { CodeMirror } from './codemirror';
import { EditorPlugin } from './editor_plugin';
import { useFlatSQLState, useFlatSQLDispatch } from '../flatsql_state';

import iconMainScript from '../../static/svg/icons/database_search.svg';
import iconExternalScript from '../../static/svg/icons/database.svg';
import iconLoadExample from '../../static/svg/icons/folder_open.svg';
import iconAccount from '../../static/svg/icons/account_circle.svg';

import styles from './editor.module.css';

enum TabId {
    MAIN_SCRIPT = 1,
    EXTERNAL_SCRIPT = 2,
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

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const ctx = useFlatSQLState();
    const ctxDispatch = useFlatSQLDispatch();
    const [activeTab, setActiveTab] = React.useState<TabId>(TabId.MAIN_SCRIPT);
    const [folderOpen, setFolderOpen] = React.useState<boolean>(false);

    const initialText = React.useMemo(() => {
        return ctx.mainScript?.toString() ?? '';
    }, [ctx.mainScript]);

    if (ctx.mainScript == null) {
        return <div>Loading</div>;
    }

    const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        const tab = (event.target as any).getAttribute('data-tab') as TabId;
        setActiveTab(tab);
    };
    const toggleOpenFolder = () => setFolderOpen(s => !s);

    // XXX the plugin is initialized with every update here...
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
                <Tab id={TabId.MAIN_SCRIPT} active={activeTab} icon={iconMainScript} onClick={onClick} />
                <Tab id={TabId.EXTERNAL_SCRIPT} active={activeTab} icon={iconExternalScript} onClick={onClick} />
                <div style={{ flex: 1 }} />
                <Tab id={TabId.ACCOUNT} active={activeTab} icon={iconAccount} onClick={onClick} />
            </div>
            <div className={styles.editor_with_loader}>
                <div className={styles.editor}>
                    <AutoSizer>
                        {(s: { height: number; width: number }) => (
                            <CodeMirror
                                className={styles.codemirror}
                                value={initialText}
                                extensions={[
                                    EditorPlugin.of({
                                        context: ctx,
                                        dispatchContext: ctxDispatch,
                                    }),
                                ]}
                                width={`${s.width}px`}
                                height={`${s.height}px`}
                            />
                        )}
                    </AutoSizer>
                </div>
                <div className={styles.loader_container} style={{ display: folderOpen ? 'block' : 'none' }} />
            </div>
        </div>
    );
};
