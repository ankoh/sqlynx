import * as React from 'react';
import ReactFlow, { BackgroundVariant, Background as FlowBackground } from 'reactflow';
import { TableNode, layoutSchema } from './schema_graph_node';
import { useFlatSQLState } from '../flatsql_state';

interface Props {
    className?: string;
    width: number;
    height: number;
}

export const SchemaGraph: React.FC<Props> = (props: Props) => {
    const state = useFlatSQLState();
    const nodeTypes = React.useMemo(() => ({ table: TableNode }), []);

    // Render placeholder if context is not available
    if (!state) {
        <div className={props.className}>
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
        </div>;
    }

    const [nodes, edges] = layoutSchema(state);
    return (
        <div className={props.className}>
            <ReactFlow
                nodeTypes={nodeTypes}
                nodes={nodes}
                edges={edges}
                zoomOnScroll={false}
                zoomOnPinch={false}
                zoomOnDoubleClick={false}
                panOnDrag={false}
                panOnScroll={false}
                proOptions={{ hideAttribution: true }}
            >
                <FlowBackground color="#aaa" variant={BackgroundVariant.Dots} gap={16} />
            </ReactFlow>
        </div>
    );
};
