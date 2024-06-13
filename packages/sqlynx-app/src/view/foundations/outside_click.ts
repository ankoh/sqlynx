import * as React from 'react'

type TouchOrMouseEventCallback = (event: MouseEvent | TouchEvent) => boolean | undefined

const STOP_PROPAGATION = true;
const REGISTRY: {[id: number]: TouchOrMouseEventCallback} = {}
let NEXT_HANDLER_ID = 1

function handleClick(event: MouseEvent) {
    if (!event.defaultPrevented) {
        for (const handler of Object.values(REGISTRY).reverse()) {
            if (handler(event) === STOP_PROPAGATION || event.defaultPrevented) {
                break
            }
        }
    }
}

interface UseOnOutsideClickArgs {
    containerRef: React.RefObject<HTMLDivElement> | React.RefObject<HTMLUListElement>
    ignoreClickRefs?: React.RefObject<HTMLElement>[]
    onClickOutside: (e: MouseEvent | TouchEvent) => void
}

export function useOnOutsideClick(args: UseOnOutsideClickArgs) {
    const id = React.useMemo(() => NEXT_HANDLER_ID++, [])

    const handler = React.useCallback<TouchOrMouseEventCallback>(
        event => {
            // Don't call click handler if the mouse event was triggered by an auxiliary button (right click/wheel button/etc)
            if (event instanceof MouseEvent && event.button > 0) {
                return STOP_PROPAGATION;
            }
            // Don't call handler if the click happened inside of the container
            if (args.containerRef.current?.contains(event.target as Node)) {
                return STOP_PROPAGATION;
            }
            // Don't call handler if click happened on an ignored ref
            if (args.ignoreClickRefs && args.ignoreClickRefs.some(({current}) => current?.contains(event.target as Node))) {
                return STOP_PROPAGATION;
            }

            args.onClickOutside(event)
        },
        [args.containerRef, args.ignoreClickRefs, args.onClickOutside],
    )

    React.useEffect(() => {
        if (Object.keys(REGISTRY).length === 0) {
            // use capture to ensure we get all events
            document.addEventListener('mousedown', handleClick, {capture: true})
        }
        REGISTRY[id] = handler;

        return () => {
            delete REGISTRY[id];
            if (Object.keys(REGISTRY).length === 0) {
                document.removeEventListener('mousedown', handleClick, {capture: true})
            }
        }
    }, [id, handler])
}