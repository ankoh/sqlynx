import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';
import cn from 'classnames';

import { useBackend, useBackendResolver } from '../backend';
import { CodeMirror } from './codemirror';
import { FlatSQLExtension } from './codemirror_extension';

import iconMainScript from '../../static/svg/icons/database_search.svg';
import iconExternalScript from '../../static/svg/icons/database.svg';
import iconLoadExample from '../../static/svg/icons/school.svg';

import styles from './script_editor.module.css';

interface Props {}

export const ScriptEditor: React.FC<Props> = (props: Props) => {
    const backend = useBackend();
    const backendResolver = useBackendResolver();
    if (backend.unresolved()) {
        backendResolver();
    }

    // Prepare a script for the editor
    const [script, setScript] = React.useState<flatsql.FlatSQLScript | null>(null);
    const instance = backend.value?.instance;
    React.useEffect(() => {
        if (!instance) return;
        const s = instance!.createScript();
        setScript(s);
        return () => {
            s?.delete();
        };
    }, [instance]);

    if (instance) {
        const config = {
            instance,
            script: instance.createScript(),
        };
        return (
            <div className={styles.container}>
                <div className={styles.headerbar}>
                    <div className={styles.headerbar_right}>
                        <div className={styles.example_loader_container}>
                            <div className={styles.example_loader_selected}></div>
                            <div className={styles.example_loader_button}>
                                <svg width="18px" height="18px">
                                    <use xlinkHref={`${iconLoadExample}#sym`} />
                                </svg>
                            </div>
                        </div>
                    </div>
                </div>
                <div className={styles.tabbar}>
                    <div className={cn(styles.tabbar_tab)}>
                        <svg width="22px" height="22px">
                            <use xlinkHref={`${iconMainScript}#sym`} />
                        </svg>
                    </div>
                    <div className={cn(styles.tabbar_tab, styles.tabbar_tab_active)}>
                        <svg width="22px" height="22px">
                            <use xlinkHref={`${iconExternalScript}#sym`} />
                        </svg>
                    </div>
                </div>
                <CodeMirror
                    className={styles.codemirror}
                    value="Psst, this is work in progress..."
                    height="200px"
                    extensions={[FlatSQLExtension.of(config)]}
                />
            </div>
        );
    } else {
        return <div>Loading</div>;
    }
};
