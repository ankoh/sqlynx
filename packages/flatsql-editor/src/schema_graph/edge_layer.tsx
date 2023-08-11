import * as React from 'react';

import { Action } from '../utils/action';
import { EdgeViewModel } from './graph_view_model';
import { ConnectionId, GraphFocus, buildConnectionId } from '../app_state';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: Map<ConnectionId, EdgeViewModel>;
    onFocusChanged: (connection: ConnectionId | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER,
}

interface FocusState {
    event: FocusEvent | null;
    target: ConnectionId | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
    | Action<typeof MOUSE_ENTER, ConnectionId>
    | Action<typeof MOUSE_LEAVE, ConnectionId>
    | Action<typeof CLICK, ConnectionId>;

const reducer = (state: FocusState, action: FocusAction): FocusState => {
    switch (action.type) {
        case MOUSE_ENTER: {
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            return {
                event: FocusEvent.HOVER,
                target: action.value,
            };
        }
        case MOUSE_LEAVE: {
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            return {
                event: null,
                target: null,
            };
        }
        case CLICK: {
            if (state.event == FocusEvent.CLICK && state.target === action.value) {
                return {
                    event: null,
                    target: null,
                };
            }
            return {
                event: FocusEvent.CLICK,
                target: action.value,
            };
        }
    }
};

function unpack(path: SVGPathElement): ConnectionId {
    const from = path.getAttribute('data-from')!;
    const to = path.getAttribute('data-to')!;
    return buildConnectionId(+from, +to);
}

export function EdgeLayer(props: Props) {
    const [state, dispatch] = React.useReducer(reducer, null, () => ({ event: null, target: null }));

    React.useEffect(() => {
        props.onFocusChanged(state.target);
    }, [state.target, props.onFocusChanged]);

    const onEnterEdge = React.useCallback(
        (event: React.MouseEvent<SVGPathElement>) => {
            dispatch({ type: MOUSE_ENTER, value: unpack(event.currentTarget) });
        },
        [dispatch],
    );
    const onLeaveEdge = React.useCallback(
        (event: React.MouseEvent<SVGPathElement>) => {
            dispatch({ type: MOUSE_LEAVE, value: unpack(event.currentTarget) });
        },
        [dispatch],
    );
    const onClickEdge = React.useCallback(
        (event: React.MouseEvent<SVGPathElement>) => {
            event.stopPropagation();
            dispatch({ type: CLICK, value: unpack(event.currentTarget) });
        },
        [dispatch],
    );

    const paths = [];
    for (const [conn, edge] of props.edges) {
        paths.push(
            <path
                key={conn.toString()}
                d={edge.path}
                strokeWidth="2px"
                stroke="currentcolor"
                fill="transparent"
                pointerEvents="stroke"
                data-from={edge.fromNode}
                data-to={edge.toNode}
                onMouseEnter={onEnterEdge}
                onMouseLeave={onLeaveEdge}
                onClick={onClickEdge}
            />,
        );
    }

    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {paths}
        </svg>
    );
}

interface HighlightingProps {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: Map<ConnectionId, EdgeViewModel>;
    focus: GraphFocus | null;
}

export function EdgeHighlightingLayer(props: HighlightingProps) {
    let paths = [];
    if (props.focus) {
        for (const [conn, edge] of props.edges) {
            if (!props.focus.graphConnections?.has(conn)) continue;
            paths.push(
                <path
                    key={conn.toString()}
                    d={edge.path}
                    strokeWidth="2px"
                    stroke="hsl(212.44deg, 92.07%, 44.51%)"
                    fill="transparent"
                />,
            );
        }
    }
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {paths}
        </svg>
    );
}
