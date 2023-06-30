import * as React from 'react';
import * as flatbuffers from 'flatbuffers';
import * as flatsql from '@ankoh/flatsql';

import { useBackend, useBackendResolver } from '../backend';
import { CodeMirror } from './codemirror';
import { FlatSQLExtension } from './extension';

import styles from './editor.module.css';

interface EditorProps {}

export const Editor: React.FC<EditorProps> = (props: EditorProps) => {
    const backend = useBackend();
    const backendResolver = useBackendResolver();
    if (backend.unresolved()) {
        backendResolver();
    }

    // Prepare a script for the editor
    const [script, setScript] = React.useState<flatsql.FlatSQLScript | null>(null);
    const instance = backend.value.instance.value;
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
                <div className={styles.headerbar}></div>
                <div className={styles.tabbar}></div>
                <CodeMirror
                    className={styles.codemirror}
                    value="hello world"
                    height="200px"
                    extensions={[FlatSQLExtension.of(config)]}
                />
            </div>
        );
    } else {
        return <div>Loading</div>;
    }
};
