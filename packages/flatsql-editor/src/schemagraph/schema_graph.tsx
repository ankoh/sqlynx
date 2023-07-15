import * as React from 'react';
import { TableNode, layoutSchema } from './schema_graph_node';
import { RESIZE_SCHEMA_GRAPH, useFlatSQLDispatch, useFlatSQLState } from '../flatsql_reducer';
import cn from 'classnames';

import styles from './schema_graph.module.css';

interface Props {
    className?: string;
    width: number;
    height: number;
}

const Background = () => (
    <svg data-testid="rf__background" className={styles.graph_background}>
        <pattern
            id="pattern-1undefined"
            x="0"
            y="0"
            width="16"
            height="16"
            patternUnits="userSpaceOnUse"
            patternTransform="translate(-0.5,-0.5)"
        >
            <circle cx="0.5" cy="0.5" r="0.5" fill="#aaa"></circle>
        </pattern>
        <rect x="0" y="0" width="100%" height="100%" fill="url(#pattern-1undefined)"></rect>
    </svg>
);

export const SchemaGraph: React.FC<Props> = (props: Props) => {
    const state = useFlatSQLState();
    const dispatch = useFlatSQLDispatch();

    React.useEffect(() => {
        dispatch({
            type: RESIZE_SCHEMA_GRAPH,
            value: [props.width, 0.45 * props.height],
        });
    }, [props.width, props.height]);

    // Render placeholder if context is not available
    if (!state) {
        <div className={props.className}>
            <Background />
        </div>;
    }

    const [nodes, edges] = layoutSchema(state);
    return (
        <div className={cn(styles.graph_container, props.className)}>
            <Background />
            <div className={styles.graph_nodes}>
                {nodes.map(n => (
                    <TableNode key={n.tableId} {...n} />
                ))}
            </div>
        </div>
    );
};
