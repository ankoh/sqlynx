import * as React from 'react';

import { Action } from '../utils/action';
import { EdgeLayout } from './graph_layout';
import { FocusInfo } from '../app_state';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
    onFocusChanged: (edge: BigInt | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER,
}

interface FocusState {
    event: FocusEvent | null;
    target: BigInt | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
    | Action<typeof MOUSE_ENTER, BigInt>
    | Action<typeof MOUSE_LEAVE, BigInt>
    | Action<typeof CLICK, BigInt>;

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

function unpack(path: SVGPathElement): BigInt {
    const graphEdge = path.getAttribute('data-from')!;
    const layoutEdge = path.getAttribute('data-to')!;
    return (BigInt(+graphEdge) << 32n) | BigInt(+layoutEdge);
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
                    data-from={e.fromNode}
                    data-to={e.toNode}
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
            const edge = props.edges[i];
            const edgeNodes = (BigInt(edge.fromNode) << 32n) | BigInt(edge.toNode);
            if (!props.focus.graphEdgeNodes?.has(edgeNodes)) continue;
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
