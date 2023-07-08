import * as React from 'react';

import { useBackend } from '../backend';
import { ScriptEditor } from '../editor/editor';
import { SchemaGraph } from '../schemagraph/schema_graph';
import { RESULT_OK } from '../utils/result';

import 'reactflow/dist/style.css';
import styles from './editor_page.module.css';

import iconGitHub from '../../static/svg/icons/github.svg';
import iconBug from '../../static/svg/icons/bug.svg';
import iconShare from '../../static/svg/icons/link.svg';
import logo from '../../static/svg/logo/logo.svg';

interface Props {}

export const EditorPage: React.FC<Props> = (props: Props) => {
    const backend = useBackend();
    const version = React.useMemo(() => {
        if (!backend || backend.type != RESULT_OK) return 'unknown';
        return backend.value.getVersionText();
    }, [backend]);

    return (
        <div className={styles.page}>
            <SchemaGraph className={styles.schemagraph_container} />
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
                    <div className={styles.header_button}>
                        <svg width="22px" height="22px">
                            <use xlinkHref={`${iconBug}#sym`} />
                        </svg>
                    </div>
                    <div className={styles.header_button}>
                        <svg width="22px" height="22px">
                            <use xlinkHref={`${iconGitHub}#sym`} />
                        </svg>
                    </div>
                </div>
            </div>
            <div className={styles.editor_container} style={{ height: '55%' }}>
                <div className={styles.editor_card}>
                    <ScriptEditor />
                </div>
            </div>
        </div>
    );
};
