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
    finishDirect(): string {
        const p = this.path;
        this.toX = p[2];
        this.toY = p[3];
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]}`;
    }
    finish1Turn(): string {
        const p = this.path;
        this.toX = p[2];
        this.toY = p[3];
        return `M ${p[0]} ${p[1]} L ${p[2]} ${p[3]}`;
    }
    finish2Turns(): string {
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

    const borderRadius = 20;

    const diffX = Math.abs(edge.toX - edge.fromX);
    const diffY = Math.abs(edge.toY - edge.fromY);
    const midX = diffX / 2;
    const midY = diffY / 2;

    let pathText: string = '';
    switch (edge.orientation) {
        case PathOrientation.North:
        case PathOrientation.West:
        case PathOrientation.South:
        case PathOrientation.East:
            path.begin(edge.fromX, edge.fromY);
            path.push(edge.toX, edge.toY);
            return path.finishDirect();

        case PathOrientation.SouthWest:
        case PathOrientation.SouthEast:
        case PathOrientation.NorthEast:
        case PathOrientation.NorthWest:
        case PathOrientation.WestSouth:
        case PathOrientation.EastSouth:
        case PathOrientation.EastNorth:
        case PathOrientation.WestNorth:
            path.begin(edge.fromX, edge.fromY);
            path.push(edge.toX, edge.toY);
            return path.finishDirect();

        case PathOrientation.EastNorthEast:
            path.begin(edge.fromX + width / 2, edge.fromY); // A
            path.push(edge.fromX + Math.max(midX, borderRadius) - borderRadius, edge.fromY); // B
            path.push(edge.fromX + midX, edge.fromY); // C
            path.push(edge.fromX + midX, edge.fromY + Math.min(borderRadius, diffY / 2)); // D
            path.push(edge.fromX + midX, edge.fromY + diffY - Math.min(borderRadius, diffY / 2)); // E
            path.push(edge.fromX + midX, edge.toY); // F
            path.push(edge.toX - (Math.max(midX, borderRadius) - borderRadius), edge.toY); // G
            path.push(edge.toX - width / 2, edge.toY); // H
            return path.finish2Turns();

        case PathOrientation.SouthEastSouth:
            path.begin(edge.fromX, edge.fromY - height / 2); // A
            path.push(edge.fromX, edge.fromY - Math.max(midY, borderRadius) + borderRadius); // B
            path.push(edge.fromX, edge.fromY - midY); // C
            path.push(edge.fromX + Math.min(borderRadius, diffX / 2), edge.fromY - midY); // D
            path.push(edge.fromX + diffX - Math.min(borderRadius, diffX / 2), edge.fromY - midY); // E
            path.push(edge.toX, edge.fromY - midY); // F
            path.push(edge.toX, edge.toY + (Math.max(midY, borderRadius) - borderRadius)); // G
            path.push(edge.toX, edge.toY + height / 2); // H
            return path.finish2Turns();

        case PathOrientation.SouthWestSouth:
        case PathOrientation.NorthEastNorth:
        case PathOrientation.NorthWestNorth:
        case PathOrientation.WestSouthWest:
        case PathOrientation.EastSouthEast:
        case PathOrientation.WestNorthWest:
            path.begin(edge.fromX, edge.fromY);
            path.push(edge.toX, edge.toY);
            return path.finishDirect();
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
