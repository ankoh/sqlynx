import * as React from 'react';
import { NodeLayer } from './node_layer';
import { EdgeLayer } from './edge_layer';
import { BackgroundLayer } from './background_layer';
import { layoutSchemaGraph } from './schema_graph_layout';
import { RESIZE_SCHEMA_GRAPH, useAppStateDispatch, useAppState } from '../app_state_reducer';
import cn from 'classnames';

import styles from './schema_graph.module.css';

interface Props {
    className?: string;
    width: number;
    height: number;
}

export const SchemaGraph: React.FC<Props> = (props: Props) => {
    const state = useAppState();
    const dispatch = useAppStateDispatch();

    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, 0.45 * props.height],
        });
    }, [props.width, props.height]);

    // Render placeholder if context is not available
    if (!state) {
        <div className={props.className}>
            <BackgroundLayer />
        </div>;
    }

    const [nodes, edges] = layoutSchemaGraph(state);
    // console.log([nodes, edges]); XXX
    return (
        <div className={cn(styles.graph_container, props.className)}>
            <BackgroundLayer className={styles.graph_background} />
            <EdgeLayer
                className={styles.graph_edges}
                width={props.width}
                height={props.height}
                nodes={nodes}
                edges={edges}
            />
            <NodeLayer
                className={styles.graph_nodes}
                width={props.width}
                height={props.height}
                nodes={nodes}
                edges={edges}
            />
        </div>
    );
};
