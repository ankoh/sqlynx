import * as React from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import cn from 'classnames';

import { CodeMirror } from './codemirror';
import { EditorPlugin } from './editor_plugin';
import { useEditorContext, useEditorContextDispatch } from './editor_context';

import iconMainScript from '../../static/svg/icons/database_search.svg';
import iconExternalScript from '../../static/svg/icons/tables_connected.svg';
import iconLoadExample from '../../static/svg/icons/folder_open.svg';
import iconAccount from '../../static/svg/icons/account_circle.svg';

import styles from './editor.module.css';

interface Props {}

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const ctx = useEditorContext();
    const ctxDispatch = useEditorContextDispatch();
    const initialText = React.useMemo(() => {
        return ctx.mainScript?.toString() ?? '';
    }, [ctx.mainScript]);

    if (ctx.mainScript == null) {
        return <div>Loading</div>;
    }

    // XXX the plugin is initialized with every update here...
    return (
        <div className={styles.container}>
            <div className={styles.headerbar}>
                <div className={styles.headerbar_left}>
                    <div className={styles.headerbar_script_title}>SQL Schema</div>
                </div>
                <div className={styles.headerbar_right}>
                    <div className={styles.example_loader_container}>
                        <div className={styles.example_loader_button}>
                            <svg width="20px" height="20px">
                                <use xlinkHref={`${iconLoadExample}#sym`} />
                            </svg>
                        </div>
                    </div>
                </div>
            </div>
            <div className={styles.navbar}>
                <div className={styles.navbar_tabs}>
                    <div className={cn(styles.navbar_tab)}>
                        <svg width="22px" height="22px">
                            <use xlinkHref={`${iconMainScript}#sym`} />
                        </svg>
                    </div>
                    <div className={cn(styles.navbar_tab, styles.navbar_tab_active)}>
                        <svg width="22px" height="22px">
                            <use xlinkHref={`${iconExternalScript}#sym`} />
                        </svg>
                    </div>
                </div>
                <div className={styles.navbar_account}>
                    <div className={styles.navbar_account_button}>
                        <svg width="24px" height="24px">
                            <use xlinkHref={`${iconAccount}#sym`} />
                        </svg>
                    </div>
                </div>
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
                <div className={styles.loader_container} />
            </div>
        </div>
    );
};
