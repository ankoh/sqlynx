import * as React from 'react';

import { NodeLayout } from './schema_graph_layout';
import { EdgeLayout } from './schema_graph_layout';

interface Props {
    className?: string;
    width: number;
    height: number;
    nodes: NodeLayout[];
    edges: EdgeLayout[];
}

export function EdgeLayer(props: Props) {
    console.log(props.edges);

    return (
        <svg className={props.className} viewBox={'0 0 ' + props.width + ' ' + props.height}>
            {props.edges.map((e, i) => {
                let path = `M ${e.path[0]} ${e.path[1]} L ${e.path[2]} ${e.path[3]}`;
                return <path key={i} d={path} stroke="black" />;
            })}
        </svg>
    );
}
