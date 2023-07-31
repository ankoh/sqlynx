import * as React from 'react';

import { Action } from '../utils/action';
import { EdgeLayout } from './graph_layout';
import { FocusInfo, GraphEdgeDescriptor } from '../app_state';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
    onFocusChanged: (edge: GraphEdgeDescriptor | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER,
}

interface FocusState {
    event: FocusEvent | null;
    target: GraphEdgeDescriptor | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
    | Action<typeof MOUSE_ENTER, GraphEdgeDescriptor>
    | Action<typeof MOUSE_LEAVE, GraphEdgeDescriptor>
    | Action<typeof CLICK, GraphEdgeDescriptor>;

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
            if (state.event == FocusEvent.CLICK && state.target?.layoutEdgeId === action.value.layoutEdgeId) {
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

function unpack(path: SVGPathElement): GraphEdgeDescriptor {
    const graphEdge = path.getAttribute('data-graph-edge')!;
    const layoutEdge = path.getAttribute('data-layout-edge')!;
    return { protoEdgeId: +graphEdge, layoutEdgeId: +layoutEdge };
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

    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {props.edges.map((e, i) => (
                <path
                    key={i}
                    d={e.path}
                    strokeWidth="2px"
                    stroke="currentcolor"
                    fill="transparent"
                    pointerEvents="stroke"
                    data-graph-edge={e.edgeId}
                    data-layout-edge={i}
                    onMouseEnter={onEnterEdge}
                    onMouseLeave={onLeaveEdge}
                    onClick={onClickEdge}
                />
            ))}
        </svg>
    );
}

interface HighlightingProps {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
    focus: FocusInfo | null;
}

export function EdgeHighlightingLayer(props: HighlightingProps) {
    let paths = [];
    if (props.focus) {
        for (let i = 0; i < props.edges.length; ++i) {
            if (!props.focus.graphLayoutEdges?.has(i)) continue;
            paths.push(
                <path
                    key={i}
                    d={props.edges[i].path}
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
