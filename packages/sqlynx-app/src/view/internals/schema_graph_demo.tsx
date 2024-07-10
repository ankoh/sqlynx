import * as React from 'react';
import * as styles from './schema_graph_demo.module.css';
import { classNames } from '../../utils/classnames.js';

import { LayoutGroup, motion } from "framer-motion";

const ACTIVE_NODE_COUNT = 3;
const PASSIVE_NODE_COUNT = 6;

const NODE_WIDTH = 40;
const NODE_HEIGHT = 40;
const NODE_PADDING_H = 4;
const NODE_PADDING_V = 4;
const ACTIVE_NODE_WIDTH = 4;
const ALTERNATE_ROW_SHIFT = 2;


type Point = bigint
const pack = (x: number, y: number): Point => {
    const a = (x < 0) ? ((1n << 31n) | BigInt(Math.abs(x))) : BigInt(x);
    const b = (y < 0) ? ((1n << 31n) | BigInt(Math.abs(y))) : BigInt(y);
    return (a << 32n) | b;
};
const untagSigned = (v: Point) => (((v >> 31n) & 1n) == 1n) ? -Number(v & (~(1n << 31n))) : Number(v);
const unpack = (v: Point): [number, number] => {
    const x = untagSigned((v >> 32n) & 0xFFFFFFFFn);
    const y = untagSigned(v & 0xFFFFFFFFn);
    return [x, y];
}
const modify = (v: Point, xFn: (v: number) => number, yFn: (v: number) => number) => {
    const x = untagSigned((v >> 32n) & 0xFFFFFFFFn);
    const y = untagSigned(v & 0xFFFFFFFFn);
    return pack(xFn(x), yFn(y));
}
const posNE = (v: Point) => modify(v, x => x + 1, y => y - 1);
const posN = (v: Point) => modify(v, x => x, y => y - 1);
const posNW = (v: Point) => modify(v, x => x - 1, y => y - 1);
const posE = (v: Point) => modify(v, x => x + 1, y => y);
const posW = (v: Point) => modify(v, x => x - 1, y => y);
const posSE = (v: Point) => modify(v, x => x + 1, y => y + 1);
const posS = (v: Point) => modify(v, x => x, y => y + 1);
const posSW = (v: Point) => modify(v, x => x - 1, y => y + 1);

enum NodeType {
    ActiveNode = 0,
    PassiveNode = 1,
}
interface PlacedNode {
    id: number;
    nodeType: NodeType;
    x: number;
    y: number;
}
interface NodeData {
    id: number;
    nodeType: NodeType;
}

/// Helper to place nodes directly
const placeNodesDirectly = (active: NodeData[], occupied: Set<bigint>, placed: Array<PlacedNode>) => {
    const free: Array<Point> = [pack(-1, 0)];
    for (const pending of active) {
        let next: Point;
        do {
            next = free.shift()!;
        } while (occupied.has(next))
        const [x, y] = unpack(next);
        placed.push({
            id: pending.id,
            nodeType: pending.nodeType,
            x,
            y,
        });
        occupied.add(next);
        free.push(posN(next));
        free.push(posE(next));
        free.push(posS(next));
        free.push(posW(next));
        free.push(posNW(next));
        free.push(posNE(next));
        free.push(posSE(next));
        free.push(posSW(next));
    }
}

/// Helper to discover free nodes around existing nodes
const discoverFreeNodes = (occupied: Set<Point>, midX: number, midY: number) => {
    if (occupied.size == 0) {
        return [pack(-1, 0)];
    }
    const free: Set<Point> = new Set();
    const add = (p: Point) => {
        if (!occupied.has(p) && !free.has(p)) {
            free.add(p);
        }
    };
    // Add all neighbors for already occupied nodes
    for (const n of occupied) {
        add(posN(n));
        add(posE(n));
        add(posS(n));
        add(posW(n));
        add(posNW(n));
        add(posNE(n));
        add(posSE(n));
        add(posSW(n));
    }
    free.forEach(p => {
        const [x, y] = unpack(p);
        const angle = Math.atan2(y - midY, x - midX);
        return angle;
    });
    // Sort all nodes that we added that way by
    const freeOrdered = [...free.values()];
    freeOrdered.sort((l, r) => {
        const [lx, ly] = unpack(l);
        const [rx, ry] = unpack(r);
        const angleL = Math.atan2(ly - midY, lx - midX);
        const angleR = Math.atan2(ry - midY, rx - midX);
        return angleL - angleR;
    });
    return freeOrdered;
}

interface GeneratedGraph {
    nodes: PlacedNode[];
}

function computeGraphViewModel(nodes: NodeData[]): GeneratedGraph {
    const actives = nodes.filter(n => n.nodeType == NodeType.ActiveNode);
    const passives = nodes.filter(n => n.nodeType == NodeType.PassiveNode);
    const placedNodes: PlacedNode[] = [];

    // Place all active nodes
    let occupied: Set<Point> = new Set();
    placeNodesDirectly(actives, occupied, placedNodes);

    // Place all passive nodes and find the middle point
    let midX = 0;
    let midY = 0;
    {
        let sumX = 0;
        let sumY = 0;
        const scaledOccupied: Set<Point> = new Set();
        for (const placed of placedNodes) {
            placed.x *= 4;

            // Shift every second row by one so that active nodes are not below each other
            if ((placed.y & 1) == 1) {
                placed.x += ALTERNATE_ROW_SHIFT;
            }

            const a = pack(placed.x, placed.y);
            const b = pack(placed.x + 1, placed.y);
            const c = pack(placed.x + 2, placed.y);
            const d = pack(placed.x + 3, placed.y);

            scaledOccupied.add(a);
            scaledOccupied.add(b);
            scaledOccupied.add(c);
            scaledOccupied.add(d);

            sumX += placed.x;
            sumX += placed.x + 1;
            sumX += placed.x + 2;
            sumX += placed.x + 3;
            sumY += placed.y * 4;
        }
        occupied = scaledOccupied;
        midX = sumX / (placedNodes.length * 4);
        midY = sumY / (placedNodes.length * 4);
    }

    // Place all passive nodes by iteratively appending new out layers around the current nodes
    let nextPassive = 0;
    while (nextPassive < passives.length) {
        const free = discoverFreeNodes(occupied, midX, midY);
        const placeHere = Math.min(passives.length - nextPassive, free.length);
        for (let i = 0; i < placeHere; ++i) {
            const passive = passives[nextPassive + i];
            const [x, y] = unpack(free[i]);
            placedNodes.push({
                id: passive.id,
                nodeType: passive.nodeType,
                x,
                y,
            });
            occupied.add(free[i]);
        }
        nextPassive += placeHere;
    }

    // Move all nodes to positives
    let minX = 0;
    let minY = 0;
    for (const placed of placedNodes) {
        minX = Math.min(minX, placed.x);
        minY = Math.min(minY, placed.y);
    }
    for (const placed of placedNodes) {
        placed.x += Math.abs(minX);
        placed.y += Math.abs(minY);
    }
    return {
        nodes: placedNodes,
    };
}

export function SchemaGraphDemoPage(): React.ReactElement {
    const [viewModel, setViewModel] = React.useState<GeneratedGraph | null>(null);
    const [nodes, setNodes] = React.useState<NodeData[]>(() => {
        let nodes = [];
        for (let i = 0; i < ACTIVE_NODE_COUNT; ++i) {
            nodes.push({
                id: nodes.length,
                nodeType: NodeType.ActiveNode
            });
        }
        for (let i = 0; i < PASSIVE_NODE_COUNT; ++i) {
            nodes.push({
                id: nodes.length,
                nodeType: NodeType.PassiveNode
            });
        }
        return nodes;
    });
    React.useEffect(() => {
        const model = computeGraphViewModel(nodes);
        setViewModel(model);
    }, [nodes]);
    const toggleNodeType = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const elem = event.currentTarget as HTMLDivElement;
        const id = Number.parseInt(elem.dataset.nodeid!);
        setNodes(nodes => {
            switch (nodes[id].nodeType) {
                case NodeType.ActiveNode:
                    nodes[id] = { ...nodes[id], nodeType: NodeType.PassiveNode };
                    break;
                case NodeType.PassiveNode:
                    nodes[id] = { ...nodes[id], nodeType: NodeType.ActiveNode };
                    break;
            }
            return [...nodes];
        })
    }, [setNodes]);

    return <div className={styles.root}>
        <div className={styles.demo_section}>
            <div className={styles.demo_section_header}>
                Schema Graph Demo
            </div>
            <div className={styles.graph_container}>
                <LayoutGroup>
                    {viewModel?.nodes.map(n => (
                        <motion.div
                            layoutId={n.id.toString()}
                            key={n.id}
                            className={classNames(styles.graph_node, {
                                [styles.graph_node_inactive]: n.nodeType == NodeType.PassiveNode
                            })}
                            style={{
                                position: 'absolute',
                                top: n.y * NODE_HEIGHT + NODE_PADDING_V,
                                left: n.x * NODE_WIDTH + NODE_PADDING_H,
                                width: ((n.nodeType == NodeType.ActiveNode) ? ACTIVE_NODE_WIDTH : 1) * NODE_WIDTH - NODE_PADDING_H * 2,
                                height: NODE_HEIGHT - NODE_PADDING_V * 2,
                            }}
                            data-nodetype={n.nodeType}
                            data-nodeid={n.id}
                            onClick={toggleNodeType}
                        >
                            {n.id}
                        </motion.div>
                    ))}
                </LayoutGroup>
            </div>
        </div>
    </div>;

}
