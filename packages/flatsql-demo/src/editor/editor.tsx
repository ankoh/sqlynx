import * as React from 'react';

import { useBackend, useBackendResolver } from '../backend';
import { CodeMirror } from './codemirror';

import styles from './editor.module.css';

interface EditorProps {}

export const Editor: React.FC<EditorProps> = (props: EditorProps) => {
    const backend = useBackend();
    const backendResolver = useBackendResolver();
    if (backend.unresolved()) {
        backendResolver();
    }
    return (
        <div className={styles.container}>
            <CodeMirror value="hello world" height='200px' />
        </div>
    );
}