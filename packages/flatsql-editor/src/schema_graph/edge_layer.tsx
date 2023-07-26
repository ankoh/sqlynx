import * as React from 'react';

import { NodeLayout } from './schema_graph_layout';
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

enum PathOrientation {
    East,
    South,
    West,
    North,
}

function getPathOrientation(fromX: number, fromY: number, toX: number, toY: number): PathOrientation {
    const diffX = toX - fromX;
    const diffY = toY - fromY;
    const angle = (Math.atan2(diffY, diffX) * 180) / Math.PI;
    console.log(`${angle}`);
    if (Math.abs(angle) <= 15) {
        return PathOrientation.East;
    }
    if (Math.abs(angle) >= 165) {
        return PathOrientation.West;
    }
    return angle > 0 ? PathOrientation.South : PathOrientation.North;
}

function patchPath(
    out: Float64Array,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    width: number,
    height: number,
): PathOrientation | null {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    if (toX - fromX == 0 && toY - fromY == 0) {
        return null;
    }
    const orientation = getPathOrientation(fromX, fromY, toX, toY);
    switch (orientation) {
        case PathOrientation.East:
            out[0] = fromX + width / 2;
            out[1] = fromY;
            out[2] = toX - width / 2;
            out[3] = toY;
            break;
        case PathOrientation.South:
            out[0] = fromX;
            out[1] = fromY + height / 2;
            out[2] = toX;
            out[3] = toY - height / 2;
            break;
        case PathOrientation.West:
            out[0] = fromX - width / 2;
            out[1] = fromY;
            out[2] = toX + width / 2;
            out[3] = toY;
            break;
        case PathOrientation.North:
            out[0] = fromX;
            out[1] = fromY - height / 2;
            out[2] = toX;
            out[3] = toY + height / 2;
            break;
    }
    return orientation;
}

export function EdgeLayer(props: Props) {
    const path = new Float64Array(4);
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => {
                const orientation = patchPath(path, e.fromX, e.fromY, e.toX, e.toY, props.nodeWidth, props.nodeHeight);
                if (orientation == null) return;
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
