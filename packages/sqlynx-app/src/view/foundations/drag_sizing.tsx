import * as React from 'react';

import * as styles from './drag_sizing.module.css';
import { classNames } from '../../utils/classnames.js';

interface PositionAttributes {
    clientX: number | string;
    clientY: number | string;
}

type NormedEvent =
    | MouseEvent
    | (TouchEvent & PositionAttributes);

function normalizeMouseEvent(e: MouseEvent | TouchEvent): NormedEvent {
    if ((e as TouchEvent).touches && (e as TouchEvent).touches[0]) {
        return {
            ...e,
            clientX: Math.round((e as TouchEvent).touches[0].clientX),
            clientY: Math.round((e as TouchEvent).touches[0].clientY)
        };
    } else {
        return e as NormedEvent;
    }
};

interface EventListeners {
    onMouseMove: (e: MouseEvent | TouchEvent) => void;
    onMouseUp: (e: MouseEvent | TouchEvent) => void;
}

interface DragHandlerProps {
    onStart: (e: MouseEvent | TouchEvent) => void;
    onEnd: (e: MouseEvent | TouchEvent) => void;
    onUpdate: (e: MouseEvent | TouchEvent) => void;
    className?: string;
    children?: React.ReactNode | undefined;
}

function DragHandler(props: DragHandlerProps) {
    const activeListeners = React.useRef<EventListeners | null>(null);
    const [isDragging, setIsDragging] = React.useState(false);

    // Helper to reset all listeners
    const resetListeners = React.useCallback(() => {
        const prev = activeListeners.current;
        if (prev) {
            activeListeners.current = null;
            window.removeEventListener('mousemove', prev.onMouseMove);
            window.removeEventListener('touchmove', prev.onMouseMove);
            window.removeEventListener('mouseup', prev.onMouseUp);
            window.removeEventListener('touchend', prev.onMouseUp);
        }
    }, []);

    // Listener for move events
    const onMouseMove = React.useCallback((e: MouseEvent | TouchEvent) => props.onUpdate(e), [props.onUpdate]);
    // Listener for mouse up events
    const onMouseUp = React.useCallback(
        (e: MouseEvent | TouchEvent) => {
            // Reset all event listeners
            resetListeners();
            // Tell components that we stopped dragging
            setIsDragging(false);
            // Call user-provided onEnd
            props.onEnd(e);
        },
        [resetListeners, props.onEnd]
    );
    // Listener for mouse down events
    const onMouseDown = React.useCallback(
        (e: React.MouseEvent | React.TouchEvent) => {
            // Reset all listeners
            resetListeners();
            // Tell components that we started dragging
            setIsDragging(true);
            // Remember current listeners
            activeListeners.current = {
                onMouseMove,
                onMouseUp,
            };
            // Subscribe to window mouse events
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('touchmove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
            window.addEventListener('touchend', onMouseUp);
            // Fire onStart event
            props.onStart(e.nativeEvent);
        },
        [resetListeners, onMouseMove, onMouseUp, props.onStart]
    );

    // Reset listeners on unmount (if any)
    React.useEffect(() => (() => resetListeners()), []);

    return (
        <div
            onMouseDown={onMouseDown}
            onTouchStart={onMouseDown}
            className={classNames(styles.handler, {
                [styles.dragging]: isDragging
            })}
        >
            {props.children}
        </div>
    );
}

export enum DragSizingBorder {
    Top,
    Bottom,
    Left,
    Right
}

export interface DragSizingProps {
    border: DragSizingBorder;
    onStart?: (e: MouseEvent | TouchEvent) => void;
    onEnd?: (e: MouseEvent | TouchEvent) => void;
    onUpdate?: (e: MouseEvent | TouchEvent) => void;
    id?: string;
    className?: string;
    style?: React.CSSProperties;
    handlerClassName?: string;
    handlerStyle?: React.CSSProperties;
    handlerWidth?: number;
    handlerOffset?: number;
    handlerZIndex?: number;
    children?: React.ReactNode | undefined;
}

export const DragSizing: React.FC<DragSizingProps> = props => {
    // Maintain the drag state
    const positionWhenStarted = React.useRef<number | null>(null);
    const [sizeWhenStarted, setSizeWhenStarted] = React.useState<number | null>(null);
    const [currentDelta, setCurrentDelta] = React.useState<number>(0);

    // Determine the settings
    const config = React.useMemo(() => {
        let getSize: (o: DOMRect) => number;
        let getPosition: (o: PositionAttributes) => number;
        let setSize: (props: React.CSSProperties, v: number) => void;
        let directionFactor: 1 | -1 = 1;
        switch (props.border) {
            case DragSizingBorder.Top:
                getSize = o => o.height;
                setSize = (props, v) => props.height = v;
                getPosition = o => +o.clientY;
                directionFactor = -1;
                break;
            case DragSizingBorder.Bottom:
                getSize = o => o.height;
                setSize = (props, v) => props.height = v;
                getPosition = o => +o.clientY;
                directionFactor = 1;
                break;
            case DragSizingBorder.Left:
                getSize = o => o.width;
                setSize = (props, v) => props.width = v;
                getPosition = o => +o.clientX;
                directionFactor = -1;
                break;
            case DragSizingBorder.Right:
                getSize = o => o.width;
                setSize = (props, v) => props.width = v;
                getPosition = o => +o.clientX;
                directionFactor = 1;
                break;
        };
        return { getSize, setSize, getPosition, directionFactor };
    }, [props.border]);

    const containerRef = React.useRef<HTMLDivElement>(null);

    // Drag start
    const onStart = React.useCallback(
        (event: MouseEvent | TouchEvent) => {
            const normedEvent = normalizeMouseEvent(event);
            const container = containerRef.current;
            if (!container) return;

            const boundingRect = container.getBoundingClientRect();
            const size = config.getSize(boundingRect);
            const position = config.getPosition(normedEvent);

            setCurrentDelta(0);
            setSizeWhenStarted(size);
            positionWhenStarted.current = position;

            if (props.onStart) {
                props.onStart(normedEvent);
            }
        },
        [config, props.onStart]
    );
    // Drag end
    const onEnd = React.useCallback(
        (event: MouseEvent | TouchEvent) => {
            const normedEvent = normalizeMouseEvent(event);
            if (props.onEnd) {
                props.onEnd(normedEvent);
            }
        },
        [props.onEnd]
    );
    // Drag updates
    const onUpdate = React.useCallback(
        (event: MouseEvent | TouchEvent) => {
            const normedEvent = normalizeMouseEvent(event);

            if (positionWhenStarted.current === null) return;

            const position = config.getPosition(normedEvent);
            setCurrentDelta(position - positionWhenStarted.current);

            if (props.onUpdate) {
                props.onUpdate(normedEvent);
            }
        },
        [config, props.onUpdate]
    );

    // Compute current container style
    const containerSize: React.CSSProperties = {};
    if (sizeWhenStarted != null) {
        config.setSize(containerSize, sizeWhenStarted + currentDelta * config.directionFactor);
    }

    // The container border styles
    let containerStyle: string = "";
    switch (props.border) {
        case DragSizingBorder.Left:
            containerStyle = styles.container_w;
            break;
        case DragSizingBorder.Right:
            containerStyle = styles.container_e;
            break;
        case DragSizingBorder.Top:
            containerStyle = styles.container_n;
            break;
        case DragSizingBorder.Bottom:
            containerStyle = styles.container_s;
            break;
    }

    return (
        <div
            className={classNames(containerStyle, props.className)}
            style={containerSize}
            ref={containerRef}
        >
            <div className={styles.content}>
                {props.children}
            </div>
            <DragHandler
                onStart={onStart}
                onEnd={onEnd}
                onUpdate={onUpdate}
            />
        </div>
    );
};