import * as React from 'react';

import { EdgeLayout } from './graph_layout';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
}

export function EdgeLayer(props: Props) {
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => (
                <path
                    key={i}
                    d={e.path}
                    strokeWidth="2px"
                    stroke="currentcolor"
                    fill="transparent"
                />
            ))}
        </svg>
    );
}

interface HighlightingProps {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
    highlighting: { [key: number]: boolean };
}

export function EdgeHighlightingLayer(props: HighlightingProps) {
    let paths = [];
    for (let i = 0; i < props.edges.length; ++i) {
        if (props.highlighting[i] == undefined) continue;
        paths.push(
            <path
                key={i}
                d={props.edges[i].path}
                strokeWidth="2px"
                stroke="hsl(212.44deg, 92.07%, 44.51%)"
                fill="transparent"
            />
        );
    }
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {paths}
        </svg>
    );
}
