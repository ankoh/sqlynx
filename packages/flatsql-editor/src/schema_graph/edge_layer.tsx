import * as React from 'react';

import { NodeLayout, EdgeType } from './graph_layout';
import { EdgeLayout } from './graph_layout';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    nodes: NodeLayout[];
    edges: EdgeLayout[];
    nodeWidth: number;
    nodeHeight: number;
    gridSize: number;
    cornerRadius: number;
}

class EdgeBuilder {
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

function buildEdgePath(
    path: EdgeBuilder,
    e: EdgeLayout,
    width: number,
    height: number,
    gridSize: number,
    cornerRadius: number,
) {
    if (e.toX - e.fromX == 0 && e.toY - e.fromY == 0) {
        return;
    }

    const r = cornerRadius;

    const diffX = Math.abs(e.toX - e.fromX);
    const diffY = Math.abs(e.toY - e.fromY);
    let midX = e.fromX + (e.toX - e.fromX) / 2;
    let midY = e.fromY + (e.toY - e.fromY) / 2;
    midX = Math.round(midX / gridSize) * gridSize;
    midY = Math.round(midY / gridSize) * gridSize;

    const midXMinusR = midX - r;
    const midXPlusR = midX + r;
    const midYMinusR = midY - r;
    const midYPlusR = midY + r;
    const fromXPlusR = e.fromX + Math.min(diffX / 2, r);
    const fromXMinusR = e.fromX - Math.min(diffX / 2, r);
    const fromYPlusR = e.fromY + Math.min(diffY / 2, r);
    const fromYMinusR = e.fromY - Math.min(diffY / 2, r);
    const toXPlusR = e.toX + Math.min(diffX / 2, r);
    const toXMinusR = e.toX - Math.min(diffX / 2, r);
    const toYPlusR = e.toY + Math.min(diffY / 2, r);
    const toYMinusR = e.toY - Math.min(diffY / 2, r);

    switch (e.orientation) {
        // DIRECT

        case EdgeType.North:
        case EdgeType.South:
        case EdgeType.East:
        case EdgeType.West:
            path.begin(e.fromX, e.fromY);
            path.push(e.toX, e.toY);
            return path.buildDirect();

        // 1 TURN

        case EdgeType.NorthEast:
            path.begin(e.fromX, e.fromY + height / 2);
            path.push(e.fromX, e.fromY + Math.max(diffY, r) - r);
            path.push(e.fromX, e.toY);
            path.push(e.toX - (Math.max(diffX, r) - r), e.toY);
            path.push(e.toX - width / 2, e.toY);
            return path.build1Turn();

        case EdgeType.NorthWest:
            path.begin(e.fromX, e.fromY + height / 2);
            path.push(e.fromX, e.fromY + Math.max(diffY, r) - r);
            path.push(e.fromX, e.toY);
            path.push(e.toX + (Math.max(diffX, r) - r), e.toY);
            path.push(e.toX + width / 2, e.toY);
            return path.build1Turn();

        case EdgeType.SouthEast:
            path.begin(e.fromX, e.fromY - height / 2);
            path.push(e.fromX, e.fromY - Math.max(diffY, r) + r);
            path.push(e.fromX, e.toY);
            path.push(e.toX - (Math.max(diffX, r) - r), e.toY);
            path.push(e.toX - width / 2, e.toY);
            return path.build1Turn();

        case EdgeType.SouthWest:
            path.begin(e.fromX, e.fromY - height / 2);
            path.push(e.fromX, e.fromY - Math.max(diffY, r) + r);
            path.push(e.fromX, e.toY);
            path.push(e.toX + (Math.max(diffX, r) - r), e.toY);
            path.push(e.toX + width / 2, e.toY);
            return path.build1Turn();

        case EdgeType.EastNorth:
            path.begin(e.fromX + width / 2, e.fromY);
            path.push(e.fromX + Math.max(diffX, r) - r, e.fromY);
            path.push(e.toX, e.fromY);
            path.push(e.toX, e.toY - (Math.max(diffY, r) - r));
            path.push(e.toX, e.toY - height / 2);
            return path.build1Turn();

        case EdgeType.EastSouth:
            path.begin(e.fromX + width / 2, e.fromY);
            path.push(e.fromX + Math.max(diffX, r) - r, e.fromY);
            path.push(e.toX, e.fromY);
            path.push(e.toX, e.toY + (Math.max(diffY, r) - r));
            path.push(e.toX, e.toY + height / 2);
            return path.build1Turn();

        case EdgeType.WestNorth:
            path.begin(e.fromX - width / 2, e.fromY);
            path.push(e.fromX - Math.max(diffX, r) + r, e.fromY);
            path.push(e.toX, e.fromY);
            path.push(e.toX, e.toY - (Math.max(diffY, r) - r));
            path.push(e.toX, e.toY - height / 2);
            return path.build1Turn();

        case EdgeType.WestSouth:
            path.begin(e.fromX - width / 2, e.fromY);
            path.push(e.fromX - Math.max(diffX, r) + r, e.fromY);
            path.push(e.toX, e.fromY);
            path.push(e.toX, e.toY + (Math.max(diffY, r) - r));
            path.push(e.toX, e.toY + height / 2);
            return path.build1Turn();

        // 2 TURNS

        case EdgeType.EastNorthEast:
            path.begin(e.fromX + width / 2, e.fromY);
            path.push(midXMinusR, e.fromY);
            path.push(midX, e.fromY);
            path.push(midX, fromYPlusR);
            path.push(midX, toYMinusR);
            path.push(midX, e.toY);
            path.push(midXPlusR, e.toY);
            path.push(e.toX - width / 2, e.toY);
            return path.build2Turns();

        case EdgeType.EastSouthEast:
            path.begin(e.fromX + width / 2, e.fromY);
            path.push(midXMinusR, e.fromY);
            path.push(midX, e.fromY);
            path.push(midX, fromYMinusR);
            path.push(midX, toYPlusR);
            path.push(midX, e.toY);
            path.push(midXPlusR, e.toY);
            path.push(e.toX - width / 2, e.toY);
            return path.build2Turns();

        case EdgeType.SouthEastSouth:
            path.begin(e.fromX, e.fromY - height / 2);
            path.push(e.fromX, midYPlusR);
            path.push(e.fromX, midY);
            path.push(fromXPlusR, midY);
            path.push(toXMinusR, midY);
            path.push(e.toX, midY);
            path.push(e.toX, midYMinusR); // XXX
            path.push(e.toX, e.toY + height / 2);
            return path.build2Turns();

        case EdgeType.SouthWestSouth:
            path.begin(e.fromX, e.fromY - height / 2);
            path.push(e.fromX, midYPlusR);
            path.push(e.fromX, midY);
            path.push(fromXMinusR, midY);
            path.push(toXPlusR, midY);
            path.push(e.toX, midY);
            path.push(e.toX, midYMinusR);
            path.push(e.toX, e.toY + height / 2);
            return path.build2Turns();

        case EdgeType.WestNorthWest:
            path.begin(e.fromX - width / 2, e.fromY);
            path.push(midXPlusR, e.fromY);
            path.push(midX, e.fromY);
            path.push(midX, fromYPlusR);
            path.push(midX, toYMinusR);
            path.push(midX, e.toY);
            path.push(midXMinusR, e.toY);
            path.push(e.toX + width / 2, e.toY);
            return path.build2Turns();

        case EdgeType.WestSouthWest:
            path.begin(e.fromX - width / 2, e.fromY);
            path.push(midXPlusR, e.fromY);
            path.push(midX, e.fromY);
            path.push(midX, fromYMinusR);
            path.push(midX, toYPlusR);
            path.push(midX, e.toY);
            path.push(midXMinusR, e.toY);
            path.push(e.toX + width / 2, e.toY);
            return path.build2Turns();

        case EdgeType.NorthEastNorth:
            path.begin(e.fromX, e.fromY + height / 2);
            path.push(e.fromX, midYMinusR);
            path.push(e.fromX, midY);
            path.push(fromXPlusR, midY);
            path.push(toXMinusR, midY);
            path.push(e.toX, midY);
            path.push(e.toX, midYPlusR);
            path.push(e.toX, e.toY - height / 2);
            return path.build2Turns();

        case EdgeType.NorthWestNorth:
            path.begin(e.fromX, e.fromY + height / 2);
            path.push(e.fromX, midYMinusR);
            path.push(e.fromX, midY);
            path.push(fromXMinusR, midY);
            path.push(toXPlusR, midY);
            path.push(e.toX, midY);
            path.push(e.toX, midYPlusR);
            path.push(e.toX, e.toY - height / 2);
            return path.build2Turns();
    }
}

export function EdgeLayer(props: Props) {
    const path = new EdgeBuilder();
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => {
                const pathText = buildEdgePath(
                    path,
                    e,
                    props.nodeWidth,
                    props.nodeHeight,
                    props.gridSize,
                    props.cornerRadius,
                );
                if (e.orientation == null) return;
                return (
                    <g key={i}>
                        <path
                            d={pathText}
                            strokeWidth="2px"
                            stroke="currentcolor"
                            fill="transparent"
                            data-orientation={e.orientation}
                        />
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
