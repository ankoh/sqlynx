import * as React from 'react';
import * as flatbuffers from 'flatbuffers';
import * as flatsql from '@ankoh/flatsql';

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

    const parser = backend.value.parser.value;
    if (parser) {
        let result: flatsql.WasmBuffer | null = null;
        try {
            result = parser.parse("select 42");
            const byteBuffer = new flatbuffers.ByteBuffer(result.getData());
            const program = flatsql.proto.Program.getRootAsProgram(byteBuffer);
            console.log(`statementsLength: ${program.statementsLength()}`);
        } catch(e) {
            console.error(e);
        } finally {
            result!.delete();
        }
    }
    return (
        <div className={styles.container}>
            <CodeMirror value="hello world" height='200px' />
        </div>
    );
}