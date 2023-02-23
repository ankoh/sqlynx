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

    const parser = backend.value.parser.value;
    if (parser) {
        let result: flatsql.WasmBuffer | null = null;
        try {
            result = parser.parseString("select 42");
            const byteBuffer = new flatbuffers.ByteBuffer(result.getData());
            const program = flatsql.proto.Program.getRootAsProgram(byteBuffer);
            console.log(`statementsLength: ${program.statementsLength()}`);
        } catch(e) {
            console.error(e);
        } finally {
            if (result) {
                result.delete();
            }
        }

        const config = {
            parser
        };
        return (
            <div className={styles.container}>
                <CodeMirror value="hello world" height='200px' extensions={[
                    FlatSQLExtension.of(config)
                ]} />
            </div>
        );
    } else {
        return <div>Loading</div>
    }

}