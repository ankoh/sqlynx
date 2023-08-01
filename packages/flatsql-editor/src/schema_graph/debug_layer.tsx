import * as React from 'react';
import * as flatsql from '@ankoh/flatsql';

import { AppState } from '../app_state';
import { NodeViewModel } from './graph_view_model';

import styles from './debug_layer.module.css';

export interface DebugInfo {
    nodeCount: number;
    fromX: Float64Array;
    fromY: Float64Array;
    toX: Float64Array;
    toY: Float64Array;
    distance: Float64Array;
    repulsion: Float64Array;
}

export function buildDebugInfo(ctx: AppState, nodes: NodeViewModel[]): DebugInfo {
    const protoDebugInfo = new flatsql.proto.SchemaGraphDebugInfo();
    const debugInfo = ctx.graphDebugInfo!.read(protoDebugInfo)!;
    const nodeDistances = debugInfo.nodeDistancesArray()!;
    const nodeRepulsions = debugInfo.nodeRepulsionsArray()!;
    const n = nodeDistances.length;

    const out: DebugInfo = {
        nodeCount: nodes.length,
        fromX: new Float64Array(n),
        fromY: new Float64Array(n),
        toX: new Float64Array(n),
        toY: new Float64Array(n),
        distance: new Float64Array(n),
        repulsion: new Float64Array(n),
    };

    let pos = 0;
    for (let i = 0; i < nodes.length; ++i) {
        for (let j = i + 1; j < nodes.length; ++j) {
            const p = pos++;
            out.fromX[p] = nodes[i].x + nodes[i].width / 2;
            out.fromY[p] = nodes[i].y + nodes[i].height / 2;
            out.toX[p] = nodes[j].x + nodes[j].width / 2;
            out.toY[p] = nodes[j].y + nodes[j].height / 2;
            out.distance[p] = nodeDistances[p];
            out.repulsion[p] = nodeRepulsions[p];
        }
    }
    return out;
}

interface Props {
    className?: string;
    width: number;
    height: number;
    info: DebugInfo;
}

export function DebugLayer(props: Props) {
    const paths = [];
    const texts = [];
    for (let i = 0; i < props.info.fromX.length; ++i) {
        const path = `M ${props.info.fromX[i]} ${props.info.fromY[i]} L ${props.info.toX[i]} ${props.info.toY[i]}`;
        paths.push(<path key={i} d={path} stroke="currentcolor" strokeDasharray={8} />);
        const textPosX = props.info.fromX[i] + (props.info.toX[i] - props.info.fromX[i]) / 2;
        const textPosY = props.info.fromY[i] + (props.info.toY[i] - props.info.fromY[i]) / 2;
        texts.push(
            <text key={i} x={textPosX} y={textPosY} className={styles.edge_label}>
                {props.info.distance[i].toFixed(2)} / {props.info.repulsion[i].toFixed(2)}
            </text>,
        );
    }

    return (
        <svg className={props.className} viewBox={'0 0 ' + props.width + ' ' + props.height}>
            <g>{paths}</g>
            <g>{texts}</g>
        </svg>
    );
}
