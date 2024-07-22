import * as React from 'react';
import * as styles from './catalog_viewer.module.css';

import { LayoutGroup, motion } from "framer-motion";

interface EdgeLayerProps {
    width: number;
    height: number;
    padding: number;
    paths: React.ReactElement[];
}

export function EdgeLayer(props: EdgeLayerProps) {
    return (
        <div
            className={styles.edge_layer}
            style={{
                padding: props.padding,
            }}
        >
            <LayoutGroup>
                <motion.svg
                    viewBox={`0 0 ${props.width} ${props.height}`}
                    width={props.width}
                    height={props.height}
                    initial="hidden"
                    animate="visible"
                >
                    {props.paths}
                </motion.svg>
            </LayoutGroup>
        </div>
    );
}
