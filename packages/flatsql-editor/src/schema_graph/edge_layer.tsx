import * as React from 'react';

import { NodeLayout, PathOrientation } from './schema_graph_layout';
import { EdgeLayout } from './schema_graph_layout';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    nodes: NodeLayout[];
    edges: EdgeLayout[];
    nodeWidth: number;
    nodeHeight: number;
}

function patchPath(out: Float64Array, edge: EdgeLayout, width: number, height: number) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    if (edge.toX - edge.fromX == 0 && edge.toY - edge.fromY == 0) {
        return;
    }
    console.log(edge);
    switch (edge.orientation) {
        case PathOrientation.East:
            out[0] = edge.fromX + width / 2;
            out[1] = edge.fromY;
            out[2] = edge.toX - width / 2;
            out[3] = edge.toY;
            break;
        case PathOrientation.South:
            out[0] = edge.fromX;
            out[1] = edge.fromY + height / 2;
            out[2] = edge.toX;
            out[3] = edge.toY - height / 2;
            break;
        case PathOrientation.West:
            out[0] = edge.fromX - width / 2;
            out[1] = edge.fromY;
            out[2] = edge.toX + width / 2;
            out[3] = edge.toY;
            break;
        case PathOrientation.North:
            out[0] = edge.fromX;
            out[1] = edge.fromY - height / 2;
            out[2] = edge.toX;
            out[3] = edge.toY + height / 2;
            break;
    }
}

export function EdgeLayer(props: Props) {
    const path = new Float64Array(4);
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => {
                patchPath(path, e, props.nodeWidth, props.nodeHeight);
                if (e.orientation == null) return;
                const pathText = `M ${path[0]} ${path[1]} L ${path[2]} ${path[3]}`;
                return (
                    <g key={i}>
                        <path d={pathText} strokeWidth="1px" stroke="currentcolor" />
                        <circle cx={path[0]} cy={path[1]} r="6px" fill="white" />
                        <circle cx={path[0]} cy={path[1]} r="4px" fill="currentcolor" />
                        <circle cx={path[2]} cy={path[3]} r="6px" fill="white" />
                        <circle cx={path[2]} cy={path[3]} r="4px" fill="currentcolor" />
                    </g>
                );
            })}
        </svg>
    );
}
