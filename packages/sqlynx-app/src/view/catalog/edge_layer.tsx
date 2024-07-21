import * as React from 'react';
import * as styles from './catalog_viewer.module.css';

interface EdgeLayerProps {
    width: number;
    height: number;
    padding: number;
    paths: string[];
}

export function EdgeLayer(props: EdgeLayerProps) {
    const paths = [];
    for (let i = 0; i < props.paths.length; ++i) {
        paths.push(
            <path
                key={i.toString()}
                d={props.paths[i]}
                strokeWidth="2px"
                stroke="black"
                fill="transparent"
            />,
        );
    }
    return (
        <div
            className={styles.edge_layer}
            style={{
                padding: props.padding,
            }}
        >
            <svg
                viewBox={`0 0 ${props.width} ${props.height}`}
                width={props.width}
                height={props.height}
            >
                {paths}
            </svg>
        </div>
    );
}
