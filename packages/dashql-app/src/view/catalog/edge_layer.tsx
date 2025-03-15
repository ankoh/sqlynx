import * as React from 'react';
import * as styles from './catalog_viewer.module.css'

import { classNames } from '../../utils/classnames.js';

interface EdgeLayerProps {
    className?: string;
    width: number;
    height: number;
    padding: number;
    paths: React.ReactElement[];
}

export function EdgeLayer(props: EdgeLayerProps) {
    return (
        <div
            className={classNames(styles.layer_container, props.className)}
            style={{
                padding: props.padding,
            }}
        >
            <svg
                className={styles.layer_body}
                viewBox={`0 0 ${props.width} ${props.height}`}
                width={props.width}
                height={props.height}
            >
                {props.paths}
            </svg>
        </div>
    );
}
