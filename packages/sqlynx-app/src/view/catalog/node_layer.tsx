import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

interface NodeLayerProps {
    width: number;
    height: number;
    padding: number;
    nodes: React.ReactElement[];
}

export function NodeLayer(props: NodeLayerProps) {
    return (
        <div
            className={styles.node_layer}
            style={{
                padding: props.padding,
            }}
        >
            <div
                className={styles.node_layout}
                style={{
                    width: props.width,
                    height: props.height,
                }}
            >
                {props.nodes}
            </div>
        </div>
    );
}
