import * as React from 'react';

interface Props {
    className?: string;
    width: number;
    height: number;
    nodes: any[];
    edges: any[];
}

export function EdgeLayer(props: Props) {
    console.log(props.edges);
    return <svg className={props.className} viewBox={'0 0 ' + props.width + ' ' + props.height}></svg>;
}
