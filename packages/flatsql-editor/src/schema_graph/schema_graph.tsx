import * as flatsql from '@ankoh/flatsql';
import * as React from 'react';
import ReactFlow, { BackgroundVariant, Background as FlowBackground } from 'reactflow';

import { useEditorContext } from '../editor/editor_context';

interface Props {
    className?: string;
}

export const SchemaGraph: React.FC<Props> = (props: Props) => {
    const context = useEditorContext();

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

    const parsed = context.mainParsed?.read(new flatsql.proto.ParsedScript())!;
    const analyzed = context.mainAnalyzed?.read(new flatsql.proto.AnalyzedScript())!;
    if (analyzed) {
        // Collect tables
        const tables = [];
        const tableCount = analyzed.tablesLength();
        let tableName = new flatsql.proto.QualifiedTableName();
        let table = new flatsql.proto.Table();
        let tableColumn = new flatsql.proto.TableColumn();
        for (let i = 0; i < tableCount; ++i) {
            table = analyzed.tables(i)!;
            const columnCount = table.columnCount();
            const columnsBegin = table.columnsBegin();
            const columns = [];
            for (let j = 0; j < columnCount; ++j) {
                tableColumn = analyzed.tableColumns(columnsBegin + j)!;
                columns.push(flatsql.FlatID.readName(tableColumn.columnName(), parsed));
            }
            tableName = table.tableName(tableName)!;
            tables.push({
                name: flatsql.FlatID.readTableName(tableName, parsed),
                columns,
            });
        }
        console.log(tables);

        // Collect query edges
        const edgeCount = analyzed.graphEdgesLength();
        let edge = new flatsql.proto.QueryGraphEdge();
        let node = new flatsql.proto.QueryGraphEdgeNode();
        for (let i = 0; i < edgeCount; ++i) {
            edge = analyzed.graphEdges(i, edge)!;
            let reader = edge?.nodesBegin()!;
            const countLeft = edge?.nodeCountLeft()!;
            const countRight = edge?.nodeCountRight()!;
            let left = [],
                right = [];
            for (let j = 0; j < countLeft; ++j) {
                node = analyzed.graphEdgeNodes(reader++, node)!;
                left.push(node.columnReferenceId());
            }
            for (let j = 0; j < countRight; ++j) {
                node = analyzed.graphEdgeNodes(reader++, node)!;
                right.push(node.columnReferenceId());
            }
            console.log({
                edgeId: i,
                left,
                right,
            });
        }
    }
    return (
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
        </ReactFlow>
    );
};
