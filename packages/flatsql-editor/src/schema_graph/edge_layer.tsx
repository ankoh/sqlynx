import * as React from 'react';

import { Action } from '../utils/action';
import { EdgeLayout } from './graph_layout';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
    onFocusChanged: (edge: number | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER
}

interface FocusState {
    event: FocusEvent | null;
    edge: number | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
   | Action<typeof MOUSE_ENTER, number>
   | Action<typeof MOUSE_LEAVE, number>
   | Action<typeof CLICK, number>;

const reducer = (state: FocusState, action: FocusAction): FocusState => {
    switch (action.type) {
        case MOUSE_ENTER: {
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            return {
                event: FocusEvent.HOVER,
                edge: action.value,
            };
        };
        case MOUSE_LEAVE: {
            if (state.event === FocusEvent.CLICK) {
                return state;
            }
            return {
                event: null,
                edge: null,
            };
        };
        case CLICK: {
            if (state.edge == action.value && state.event == FocusEvent.CLICK) {
                return {
                    event: null,
                    edge: null,
                };
            }
            return {
                event: FocusEvent.CLICK,
                edge: action.value,
            };
        };
    }
};

export function EdgeLayer(props: Props) {
    const [state, dispatch] = React.useReducer(reducer, null, () => ({ event: null, edge: null }));

    React.useEffect(() => {
        props.onFocusChanged(state.edge);
    }, [state.edge, props.onFocusChanged]);

    const onEnterEdge = React.useCallback((event: React.MouseEvent<SVGPathElement>) => {
        const edgeId = event.currentTarget.getAttribute('data-edge')!;
        dispatch({ type: MOUSE_ENTER, value: +edgeId })
    }, [dispatch]);
    const onLeaveEdge = React.useCallback((event: React.MouseEvent<SVGPathElement>) => {
        const edgeId = event.currentTarget.getAttribute('data-edge')!;
        dispatch({ type: MOUSE_LEAVE, value: +edgeId })
    }, []);
    const onClickEdge = React.useCallback((event: React.MouseEvent<SVGPathElement>) => {
        event.stopPropagation();
        const edgeId = event.currentTarget.getAttribute('data-edge')!;
        dispatch({ type: CLICK, value: +edgeId })
    }, []);

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
                    data-edge={i}
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
    focus: Set<number> | null;
}

export function EdgeHighlightingLayer(props: HighlightingProps) {
    let paths = [];
    if (props.focus) {
        for (let i = 0; i < props.edges.length; ++i) {
            if (!props.focus.has(i)) continue;
            paths.push(
                <path
                    key={i}
                    d={props.edges[i].path}
                    strokeWidth="2px"
                    stroke="hsl(212.44deg, 92.07%, 44.51%)"
                    fill="transparent"
                />
            );
        }
    }
    return (
        <svg className={props.className} viewBox={'0 0 ' + props.boardWidth + ' ' + props.boardHeight}>
            {paths}
        </svg>
    );
}
