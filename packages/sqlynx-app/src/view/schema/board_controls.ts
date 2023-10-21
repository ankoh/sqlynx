import { useRef, useState, useEffect, useCallback } from 'react';

// Helper to throttle function calls through animation frames
function throttle(f: (...args: any[]) => void) {
    let token: number | null = null;
    let lastArgs: any[] | null = null;
    const invoke = () => {
        f(...lastArgs!);
        token = null;
    };
    const result = (...args: any[]) => {
        lastArgs = args;
        if (!token) {
            token = requestAnimationFrame(invoke);
        }
    };
    result.cancel = () => token && cancelAnimationFrame(token);
    return result;
}

interface DragState {
    startX: number;
    startY: number;
    previousX: number;
    previousY: number;
    translationX: number;
    translationY: number;
}

export function useBoardControls<T extends HTMLElement>(): [React.RefCallback<T>] {
    // This state doesn't change often, so it's fine
    const [dragIsActive, setDragIsActive] = useState(false);
    // Not a state since we don't want to trigger React renders.
    const dragState = useRef<DragState>({
        startX: 0,
        startY: 0,
        previousX: 0,
        previousY: 0,
        translationX: 0,
        translationY: 0,
    });

    // Proxy ref updates to also register MouseEvent handlers
    const internalRef = useRef<T | null>(null);
    const destroyInternalRef = useRef<(() => void) | null>(null);
    const updateInternalRef = useCallback((elem: T | null) => {
        // Remember als internal ref
        internalRef.current = elem;
        // Unsubscribe the current ref and handlers
        if (destroyInternalRef.current) {
            destroyInternalRef.current();
        }
        // New element is undefined?
        // Do nothing then.
        if (!elem) {
            return;
        }
        // Register new mousedown handler
        const handleMouseDown = (e: MouseEvent) => {
            if (e.target instanceof HTMLElement) {
                e.target.style.userSelect = 'none';
            }
            dragState.current = {
                startX: e.clientX,
                startY: e.clientY,
                previousX: e.clientX,
                previousY: e.clientY,
                translationX: dragState.current.translationX,
                translationY: dragState.current.translationY,
            };
            setDragIsActive(true);
        };
        elem.addEventListener('mousedown', handleMouseDown);
        destroyInternalRef.current = () => {
            elem.removeEventListener('mousedown', handleMouseDown);
            destroyInternalRef.current = null;
        };
    }, []);

    // Make sure we're unsubscribing everything when unmounting
    useEffect(() => {
        // XXX We have to explicitly trigger the ref proxy here because of this:
        // https://github.com/facebook/react/issues/24670
        //
        // React is calling useEffect twice in StrictMode while ref callbacks are only run once.
        // Therefore, using effects to destroy event handlers set by ref callbacks is not working properly.
        // As workaround, we remember if the destructor was called (destroyInternalRef.current == null)
        // and call the proxy callback again (as if the ref callback was called a second time).
        if (destroyInternalRef.current == null) {
            updateInternalRef(internalRef.current);
        }
        return () => {
            if (destroyInternalRef.current) {
                destroyInternalRef.current();
            }
        };
    }, []);

    useEffect(() => {
        // This is a flank effect only to be fired when we pressed changes to true
        if (!dragIsActive) {
            return;
        }

        // Drag handler that updates the element transform and the position ref.
        // We throttle calls to MouseMove through animation frames.
        const handleMouseMove = throttle((event: MouseEvent) => {
            if (!internalRef.current || !dragState.current) {
                return;
            }
            if (event.clientX === undefined || event.clientY === undefined) {
                return;
            }
            const dX = event.clientX - dragState.current.previousX;
            const dY = event.clientY - dragState.current.previousY;
            const state = dragState.current;
            state.previousX = event.clientX;
            state.previousY = event.clientY;
            state.translationX += dX;
            state.translationY += dY;
            const transform = `translate(${state.translationX}px, ${state.translationY}px)`;
            internalRef.current.style.transform = transform;
        });
        // Handler for the MouseUp event, stopping the dragging
        const handleMouseUp = (e: MouseEvent) => {
            if (e.target instanceof HTMLElement) {
                e.target.style.userSelect = 'auto';
            }
            setDragIsActive(false);
        };

        // Register the event handlers
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        return () => {
            handleMouseMove.cancel();
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, [dragIsActive]);

    return [updateInternalRef];
}
