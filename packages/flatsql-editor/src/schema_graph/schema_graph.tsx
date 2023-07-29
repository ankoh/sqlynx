import * as React from 'react';
import { NodeLayer } from './node_layer';
import { EdgeHighlightingLayer, EdgeLayer } from './edge_layer';
import { DebugLayer } from './debug_layer';
import { BackgroundLayer } from './background_layer';
import { buildSchemaGraphLayout } from './graph_layout';
import { buildDebugInfo } from './debug_layer';
import { RESIZE_SCHEMA_GRAPH, useAppStateDispatch, useAppState } from '../app_state_reducer';
import { ScriptKey } from '../app_state';
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

    // Recompute the schema graph if the graph dimensions change
    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, 0.45 * props.height],
        });
    }, [props.width, props.height]);

    // Build the graph layout
    const graphLayout = React.useMemo(() => buildSchemaGraphLayout(state), [state.graphLayout, state.scripts[ScriptKey.MAIN_SCRIPT], state.scripts[ScriptKey.SCHEMA_SCRIPT]]);

    // Render placeholder if context is not available
    if (!state) {
        <div className={props.className}>
            <BackgroundLayer />
        </div>;
    }

    return (
        <div className={cn(styles.graph_container, props.className)}>
            <BackgroundLayer className={styles.graph_background} />
            <EdgeLayer
                className={styles.graph_edges}
                boardWidth={props.width}
                boardHeight={props.height}
                edges={graphLayout.edges}
            />
            <NodeLayer
                className={styles.graph_nodes}
                width={props.width}
                height={props.height}
                nodes={graphLayout.nodes}
                edges={graphLayout.edges}
            />
            <EdgeHighlightingLayer
                className={styles.graph_edges}
                boardWidth={props.width}
                boardHeight={props.height}
                edges={graphLayout.edges}
                highlighting={{ 0: true }}
            />
            {state.graphDebugMode && (
                <DebugLayer
                    className={styles.graph_edges}
                    width={props.width}
                    height={props.height}
                    info={graphLayout.debugInfo}
                />
            )}
        </div>
    );
};
