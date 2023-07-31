import * as React from 'react';

import { Action } from '../utils/action';
import { EdgeLayout } from './graph_layout';
import { EdgeFocusTarget } from '../app_state_reducer';

interface Props {
    className?: string;
    boardWidth: number;
    boardHeight: number;
    edges: EdgeLayout[];
    onFocusChanged: (edge: EdgeFocusTarget | null) => void;
}

enum FocusEvent {
    CLICK,
    HOVER,
}

interface FocusState {
    event: FocusEvent | null;
    target: EdgeFocusTarget | null;
}

const MOUSE_ENTER = Symbol('MOUSE_ENTER');
const MOUSE_LEAVE = Symbol('MOUSE_LEAVE');
const CLICK = Symbol('CLICK');

type FocusAction =
    | Action<typeof MOUSE_ENTER, EdgeFocusTarget>
    | Action<typeof MOUSE_LEAVE, EdgeFocusTarget>
    | Action<typeof CLICK, EdgeFocusTarget>;

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
            if (state.target == action.value && state.event == FocusEvent.CLICK) {
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

export function EdgeLayer(props: Props) {
    const [state, dispatch] = React.useReducer(reducer, null, () => ({ event: null, target: null }));

    React.useEffect(() => {
        props.onFocusChanged(state.target);
    }, [state.target, props.onFocusChanged]);

    const onEnterEdge = React.useCallback(
        (event: React.MouseEvent<SVGPathElement>) => {
            const edgeId = event.currentTarget.getAttribute('data-edge')!;
            const fromId = event.currentTarget.getAttribute('data-from')!;
            const toId = event.currentTarget.getAttribute('data-to')!;
            dispatch({ type: MOUSE_ENTER, value: { edge: +edgeId, from: +fromId, to: +toId } });
        },
        [dispatch],
    );
    const onLeaveEdge = React.useCallback((event: React.MouseEvent<SVGPathElement>) => {
        const edgeId = event.currentTarget.getAttribute('data-edge')!;
        const fromId = event.currentTarget.getAttribute('data-from')!;
        const toId = event.currentTarget.getAttribute('data-to')!;
        dispatch({ type: MOUSE_LEAVE, value: { edge: +edgeId, from: +fromId, to: +toId } });
    }, []);
    const onClickEdge = React.useCallback((event: React.MouseEvent<SVGPathElement>) => {
        event.stopPropagation();
        const edgeId = event.currentTarget.getAttribute('data-edge')!;
        const fromId = event.currentTarget.getAttribute('data-from')!;
        const toId = event.currentTarget.getAttribute('data-to')!;
        dispatch({ type: CLICK, value: { edge: +edgeId, from: +fromId, to: +toId } });
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
                    data-edge={e.edgeId}
                    data-from={e.fromNodeId}
                    data-to={e.toNodeId}
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
            if (!props.focus.has(props.edges[i].edgeId)) continue;
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
