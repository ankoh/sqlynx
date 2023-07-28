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

class PathBuilder {
    path: Float64Array;
    i: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    constructor() {
        this.path = new Float64Array(16);
        this.i = 0;
        this.fromX = 0;
        this.fromY = 0;
        this.toX = 0;
        this.toY = 0;
    }
    reset() {
        for (let i = 0; i < 16; ++i) {
            this.path[i] = 0;
        }
        this.i = 0;
        this.fromX = 0;
        this.fromY = 0;
        this.toX = 0;
        this.toY = 0;
    }
    begin(x: number, y: number) {
        this.reset();
        this.path[0] = x;
        this.path[1] = y;
        this.fromX = x;
        this.fromY = y;
    }
    push(x: number, y: number) {
        this.i += 2;
        this.path[this.i] = x;
        this.path[this.i + 1] = y;
    }
    buildDirect(): string {
        const p = this.path;
        this.toX = p[2];
        this.toY = p[3];
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]}`;
    }
    build1Turn(): string {
        const p = this.path;
        this.toX = p[8];
        this.toY = p[9];
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]} Q ${p[4]} ${p[5]}, ${p[6]} ${p[7]} L ${p[8]} ${p[9]}`;
    }
    build2Turns(): string {
        const p = this.path;
        this.toX = p[14];
        this.toY = p[15];
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]} Q ${p[4]} ${p[5]}, ${p[6]} ${p[7]} L ${p[8]} ${p[9]} Q ${p[10]} ${p[11]}, ${p[12]} ${p[13]} L ${p[14]} ${p[15]}`;
    }
}

function buildBezier(path: PathBuilder, edge: EdgeLayout, width: number, height: number) {
    if (edge.toX - edge.fromX == 0 && edge.toY - edge.fromY == 0) {
        return;
    }

    const borderRadius = 8;

    const diffX = Math.abs(edge.toX - edge.fromX);
    const diffY = Math.abs(edge.toY - edge.fromY);
    const midX = diffX / 2;
    const midY = diffY / 2;

    switch (edge.orientation) {
        // DIRECT

        case PathOrientation.North:
        case PathOrientation.South:
        case PathOrientation.East:
        case PathOrientation.West:
            path.begin(edge.fromX, edge.fromY);
            path.push(edge.toX, edge.toY);
            return path.buildDirect();

        // 1 TURN

        case PathOrientation.NorthEast:
            path.begin(edge.fromX, edge.fromY + height / 2);
            path.push(edge.fromX, edge.fromY + Math.max(diffY, borderRadius) - borderRadius);
            path.push(edge.fromX, edge.toY);
            path.push(edge.toX - (Math.max(diffX, borderRadius) - borderRadius), edge.toY);
            path.push(edge.toX - width / 2, edge.toY);
            return path.build1Turn();

        case PathOrientation.NorthWest:
            path.begin(edge.fromX, edge.fromY + height / 2);
            path.push(edge.fromX, edge.fromY + Math.max(diffY, borderRadius) - borderRadius);
            path.push(edge.fromX, edge.toY);
            path.push(edge.toX + (Math.max(diffX, borderRadius) - borderRadius), edge.toY);
            path.push(edge.toX + width / 2, edge.toY);
            return path.build1Turn();

        case PathOrientation.SouthEast:
            path.begin(edge.fromX, edge.fromY - height / 2);
            path.push(edge.fromX, edge.fromY - Math.max(diffY, borderRadius) + borderRadius);
            path.push(edge.fromX, edge.toY);
            path.push(edge.toX - (Math.max(diffX, borderRadius) - borderRadius), edge.toY);
            path.push(edge.toX - width / 2, edge.toY);
            return path.build1Turn();

        case PathOrientation.SouthWest:
            path.begin(edge.fromX, edge.fromY - height / 2);
            path.push(edge.fromX, edge.fromY - Math.max(diffY, borderRadius) + borderRadius);
            path.push(edge.fromX, edge.toY);
            path.push(edge.toX + (Math.max(diffX, borderRadius) - borderRadius), edge.toY);
            path.push(edge.toX + width / 2, edge.toY);
            return path.build1Turn();

        case PathOrientation.EastNorth:
            path.begin(edge.fromX + width / 2, edge.fromY);
            path.push(edge.fromX + Math.max(diffX, borderRadius) - borderRadius, edge.fromY);
            path.push(edge.toX, edge.fromY);
            path.push(edge.toX, edge.toY - (Math.max(diffY, borderRadius) - borderRadius));
            path.push(edge.toX, edge.toY - height / 2);
            return path.build1Turn();

        case PathOrientation.EastSouth:
            path.begin(edge.fromX + width / 2, edge.fromY);
            path.push(edge.fromX + Math.max(diffX, borderRadius) - borderRadius, edge.fromY);
            path.push(edge.toX, edge.fromY);
            path.push(edge.toX, edge.toY + (Math.max(diffY, borderRadius) - borderRadius));
            path.push(edge.toX, edge.toY + height / 2);
            return path.build1Turn();

        case PathOrientation.WestNorth:
            path.begin(edge.fromX - width / 2, edge.fromY);
            path.push(edge.fromX - Math.max(diffX, borderRadius) + borderRadius, edge.fromY);
            path.push(edge.toX, edge.fromY);
            path.push(edge.toX, edge.toY - (Math.max(diffY, borderRadius) - borderRadius));
            path.push(edge.toX, edge.toY - height / 2);
            return path.build1Turn();

        case PathOrientation.WestSouth:
            path.begin(edge.fromX - width / 2, edge.fromY);
            path.push(edge.fromX - Math.max(diffX, borderRadius) + borderRadius, edge.fromY);
            path.push(edge.toX, edge.fromY);
            path.push(edge.toX, edge.toY + (Math.max(diffY, borderRadius) - borderRadius));
            path.push(edge.toX, edge.toY + height / 2);
            return path.build1Turn();

        // 2 TURNS

        case PathOrientation.EastNorthEast:
            path.begin(edge.fromX + width / 2, edge.fromY);
            path.push(edge.fromX + Math.max(midX, borderRadius) - borderRadius, edge.fromY);
            path.push(edge.fromX + midX, edge.fromY);
            path.push(edge.fromX + midX, edge.fromY + Math.min(borderRadius, diffY / 2));
            path.push(edge.fromX + midX, edge.fromY + diffY - Math.min(borderRadius, diffY / 2));
            path.push(edge.fromX + midX, edge.toY);
            path.push(edge.toX - (Math.max(midX, borderRadius) - borderRadius), edge.toY);
            path.push(edge.toX - width / 2, edge.toY);
            return path.build2Turns();

        case PathOrientation.SouthEastSouth:
            path.begin(edge.fromX, edge.fromY - height / 2);
            path.push(edge.fromX, edge.fromY - Math.max(midY, borderRadius) + borderRadius);
            path.push(edge.fromX, edge.fromY - midY);
            path.push(edge.fromX + Math.min(borderRadius, diffX / 2), edge.fromY - midY);
            path.push(edge.fromX + diffX - Math.min(borderRadius, diffX / 2), edge.fromY - midY);
            path.push(edge.toX, edge.fromY - midY);
            path.push(edge.toX, edge.toY + (Math.max(midY, borderRadius) - borderRadius));
            path.push(edge.toX, edge.toY + height / 2);
            return path.build2Turns();

        case PathOrientation.SouthWestSouth:
        case PathOrientation.NorthEastNorth:
        case PathOrientation.NorthWestNorth:
        case PathOrientation.WestSouthWest:
        case PathOrientation.EastSouthEast:
        case PathOrientation.WestNorthWest:
            path.begin(edge.fromX, edge.fromY);
            path.push(edge.toX, edge.toY);
            return path.buildDirect();
    }
}

export function EdgeLayer(props: Props) {
    const path = new PathBuilder();
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => {
                const pathText = buildBezier(path, e, props.nodeWidth, props.nodeHeight);
                if (e.orientation == null) return;
                return (
                    <g key={i}>
                        <path d={pathText} strokeWidth="1px" stroke="currentcolor" fill="transparent" />
                        <circle cx={path.fromX} cy={path.fromY} r="6px" fill="white" />
                        <circle cx={path.fromX} cy={path.fromY} r="3px" fill="currentcolor" />
                        <circle cx={path.toX} cy={path.toY} r="6px" fill="white" />
                        <circle cx={path.toX} cy={path.toY} r="3px" fill="currentcolor" />
                    </g>
                );
            })}
        </svg>
    );
}
