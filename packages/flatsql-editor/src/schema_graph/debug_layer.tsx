import * as React from 'react';

import { DebugInfo } from './schema_graph_layout';

import styles from './debug_layer.module.css';

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
