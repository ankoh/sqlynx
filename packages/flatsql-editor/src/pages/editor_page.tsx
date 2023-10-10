import * as React from 'react';

import { useFlatSQL } from '../flatsql_loader';
import { ScriptEditor } from '../editor/editor';
import { SchemaGraphWithControls } from '../schema_graph/schema_graph';
import { RESULT_OK } from '../utils/result';
import AutoSizer from 'react-virtualized-auto-sizer';

import styles from './editor_page.module.css';

import iconGitHub from '../../static/svg/icons/github.svg';
import iconBug from '../../static/svg/icons/bug.svg';
import iconShare from '../../static/svg/icons/link.svg';
import logo from '../../static/svg/logo/logo.svg';

interface Props {}

const openInNewTab = (url: string) => {
    const newWindow = window.open(url, '_blank', 'noopener,noreferrer');
    if (newWindow) newWindow.opener = null;
};

export const EditorPage: React.FC<Props> = (props: Props) => {
    const backend = useFlatSQL();
    const version = React.useMemo(() => {
        if (!backend || backend.type != RESULT_OK) return 'unknown';
        return backend.value.getVersionText();
    }, [backend]);

    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <div className={styles.header_left_container}>
                    <img className={styles.header_logo} src={logo} />
                    <div className={styles.header_version}>Version: {version}</div>
                </div>
                <div className={styles.header_right_container}>
                    <div className={styles.header_button_group}>
                        <div className={styles.header_button}>
                            <svg width="22px" height="22px">
                                <use xlinkHref={`${iconShare}#sym`} />
                            </svg>
                        </div>
                    </div>

                    <div className={styles.header_button_group}>
                        <div
                            className={styles.header_button}
                            onClick={() => openInNewTab('https://github.com/ankoh/flatsql/issues')}
                        >
                            <svg width="22px" height="22px">
                                <use xlinkHref={`${iconBug}#sym`} />
                            </svg>
                        </div>
                        <div
                            className={styles.header_button}
                            onClick={() => openInNewTab('https://github.com/ankoh/flatsql')}
                        >
                            <svg width="22px" height="22px">
                                <use xlinkHref={`${iconGitHub}#sym`} />
                            </svg>
                        </div>
                    </div>
                </div>
            </div>
            <div className={styles.body_container}>
                <div className={styles.schemagraph_container}>
                    <SchemaGraphWithControls className={styles.schemagraph_card} />
                </div>
                <div className={styles.editor_container}>
                    <div className={styles.editor_card}>
                        <ScriptEditor />
                    </div>
                </div>
            </div>
        </div>
    );
};
