import * as React from 'react';
import { useBackend, useBackendResolver } from '../backend';
import ReactFlow, { BackgroundVariant, Background as FlowBackground } from 'reactflow';
import { ScriptEditor } from '../editor/script_editor';

import 'reactflow/dist/style.css';
import styles from './canvas_page.module.css';

import logo from '../../static/svg/logo/logo.svg';

interface Props {}

export const CanvasPage: React.FC<Props> = (props: Props) => {
    const backend = useBackend();
    const backendResolver = useBackendResolver();
    if (backend.unresolved()) {
        backendResolver();
    }

    const instance = backend.value?.instance;
    const version = React.useMemo(() => {
        if (!instance) return 'unknown';
        return instance!.getVersionText();
    }, [instance]);

    return (
        <div className={styles.page}>
            <div className={styles.modelgraph_container}>
                <ReactFlow
                    nodes={[]}
                    edges={[]}
                    zoomOnScroll={false}
                    zoomOnPinch={false}
                    zoomOnDoubleClick={false}
                    proOptions={{ hideAttribution: true }}
                >
                    <FlowBackground color="#aaa" variant={BackgroundVariant.Dots} gap={16} />
                </ReactFlow>
            </div>
            <div className={styles.header_left_container}>
                <img className={styles.header_logo} src={logo} />
                <div className={styles.header_version}>Version: {version}</div>
            </div>
            <div className={styles.header_right_container}>
                <div className={styles.header_examples}>
                    <div>Examples</div>
                </div>
                <div className={styles.header_github_buttons}>
                    <div className={styles.header_github_button}>Bug</div>
                    <div className={styles.header_github_button}>GH</div>
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
