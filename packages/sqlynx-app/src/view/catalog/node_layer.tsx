import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

import { classNames } from '../../utils/classnames.js';

interface NodeLayerProps {
    className?: string;
    width: number;
    height: number;
    padding: number;
    nodes: React.ReactElement[];
}

export function NodeLayer(props: NodeLayerProps) {
    return (
        <div
            className={classNames(styles.layer_container, props.className)}
            style={{
                padding: props.padding,
            }}
        >
            <div
                className={styles.layer_body}
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
