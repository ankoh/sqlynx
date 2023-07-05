import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';

import ReactFlow, { BackgroundVariant, Background as FlowBackground } from 'reactflow';
import { useBackend, useBackendResolver } from '../backend';
import { ScriptEditor } from '../editor/editor';
import { useEditorContext } from '../editor/editor_context';

import 'reactflow/dist/style.css';
import styles from './canvas_page.module.css';

import iconGitHub from '../../static/svg/icons/github.svg';
import iconBug from '../../static/svg/icons/bug.svg';
import iconShare from '../../static/svg/icons/link.svg';
import logo from '../../static/svg/logo/logo.svg';

interface Props {}

export const CanvasPage: React.FC<Props> = (props: Props) => {
    const context = useEditorContext();
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

    if (context) {
        const script = context.mainAnalyzed?.read(new flatsql.proto.AnalyzedScript())!;
        console.log(script);
        if (script) {
            // Collect tables
            const tables = [];
            const tableCount = script.tablesLength();
            let table = new flatsql.proto.Table();
            let tableColumn = new flatsql.proto.TableColumn();
            for (let i = 0; i < tableCount; ++i) {
                table = script.tables(i)!;
                const columnCount = table.columnCount();
                const columnsBegin = table.columnsBegin();
                const columns = [];
                for (let j = 0; j < columnCount; ++j) {
                    tableColumn = script.tableColumns(columnsBegin + j)!;
                    columns.push(tableColumn.columnName());
                }
                tables.push({ columns });
            }
            console.log(tables);

            // Collect query edges
            const edgeCount = script.graphEdgesLength();
            let edge = new flatsql.proto.QueryGraphEdge();
            let node = new flatsql.proto.QueryGraphEdgeNode();
            for (let i = 0; i < edgeCount; ++i) {
                edge = script.graphEdges(i, edge)!;
                let reader = edge?.nodesBegin()!;
                const countLeft = edge?.nodeCountLeft()!;
                const countRight = edge?.nodeCountRight()!;
                let left = [],
                    right = [];
                for (let j = 0; j < countLeft; ++j) {
                    node = script.graphEdgeNodes(reader++, node)!;
                    left.push(node.columnReferenceId());
                }
                for (let j = 0; j < countRight; ++j) {
                    node = script.graphEdgeNodes(reader++, node)!;
                    right.push(node.columnReferenceId());
                }
                console.log({
                    edgeId: i,
                    left,
                    right,
                });
            }
        }
    }

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
