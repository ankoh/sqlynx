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
            <div className={styles.modelgraph_container}>
                <ReactFlow
                    nodes={[]}
                    edges={[]}
                    attributionPosition="bottom-right"
                    zoomOnScroll={false}
                    zoomOnPinch={false}
                    zoomOnDoubleClick={false}
                >
                    <FlowBackground color="#aaa" variant={BackgroundVariant.Dots} gap={16} />
                </ReactFlow>
            </div>
            <div className={styles.header_left_container}>
                <img className={styles.header_logo} src={logo} />
                <div className={styles.header_version}>Version: 0.0.1-dev21.0</div>
            </div>
            <div className={styles.header_right_container}>
                <div className={styles.header_examples}>
                    <div>Examples</div>
                </div>
                <div className={styles.header_github_buttons}>
                    <div className={styles.header_github_button}>Bug</div>
                    <div className={styles.header_github_button}>Star</div>
                </div>
            </div>
            <div className={styles.editor_section} style={{ height: '55%' }}>
                <div className={styles.editor_card}>
                    <ScriptEditor />
                </div>
            </div>
        </div>
    );
};
