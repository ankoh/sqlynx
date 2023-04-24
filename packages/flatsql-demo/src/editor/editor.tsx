import * as React from 'react';
import * as flatbuffers from 'flatbuffers';
import * as flatsql from '@ankoh/flatsql';

import { useBackend, useBackendResolver } from '../backend';
import { CodeMirror } from './codemirror';
import { FlatSQLExtensionConfig, FlatSQLExtension } from './extension';

import styles from './editor.module.css';

interface EditorProps {}

export const Editor: React.FC<EditorProps> = (props: EditorProps) => {
    const backend = useBackend();
    const backendResolver = useBackendResolver();
    if (backend.unresolved()) {
        backendResolver();
    }

    const instance = backend.value.instance.value;
    if (instance) {
        const config = {
            instance,
            rope: instance.createRope(),
        };
        return (
            <div className={styles.container}>
                <CodeMirror value="hello world" height="200px" extensions={[FlatSQLExtension.of(config)]} />
            </div>
        );
    } else {
        return <div>Loading</div>;
    }
};
