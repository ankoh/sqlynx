import * as React from 'react';
import ReactFlow, { BackgroundVariant, Background as FlowBackground } from 'reactflow';
import { TableNode, layoutSchema } from './schema_graph_layout';
import { useFlatSQLState } from '../flatsql_state';

interface Props {
    className?: string;
}

export const SchemaGraph: React.FC<Props> = (props: Props) => {
    const context = useFlatSQLState();
    const nodeTypes = React.useMemo(() => ({ table: TableNode }), []);

    // Render placeholder if context is not available
    if (!context) {
        <ReactFlow
            className={props.className}
            nodes={[]}
            edges={[]}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
        >
            <FlowBackground color="#aaa" variant={BackgroundVariant.Dots} gap={16} />
        </ReactFlow>;
    }

    const [nodes, edges] = layoutSchema(context);
    return (
        <ReactFlow
            className={props.className}
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
    );
};
