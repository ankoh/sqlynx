import * as React from 'react';

import { NodeLayout, EdgeLayout } from './graph_layout';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
}

export function EdgeLayer(props: Props) {
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => {
                return (
                    <path
                        key={i}
                        d={e.path}
                        strokeWidth="2px"
                        stroke="currentcolor"
                        fill="transparent"
                    />
                );
            })}
        </svg>
    );
}
