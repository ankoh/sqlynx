import * as React from 'react';
import ReactFlow, { BackgroundVariant, Background as FlowBackground } from 'reactflow';
import { ScriptEditor } from '../editor/script_editor';

import 'reactflow/dist/style.css';
import styles from './canvas_page.module.css';

import logo from '../../static/img/logo.svg';

interface Props {}

export const CanvasPage: React.FC<Props> = (props: Props) => {
    return (
        <div className={styles.page}>
            <div className={styles.header_container}>
                <img src={logo} className={styles.header_logo} />
            </div>
            <div className={styles.modelgraph_container}>
                <ReactFlow nodes={[]} edges={[]} fitView attributionPosition="bottom-right">
                    <FlowBackground color="#aaa" variant={BackgroundVariant.Dots} gap={16} />
                </ReactFlow>
            </div>
            <div className={styles.editor_section} style={{ height: '66%' }}>
                <div className={styles.editor_card}>
                    <ScriptEditor />
                </div>
            </div>
        </div>
    );
};
