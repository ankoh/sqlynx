import * as React from 'react';
import useResizeObserverRaw from '@react-hook/resize-observer';
const useResizeObserver = useResizeObserverRaw as unknown as (target: React.RefObject<HTMLElement | null> | null, callback: (entry: ResizeObserverEntry) => void) => void;

export interface ObservedSize {
    width: number;
    height: number;
}

export const OBSERVED_SIZE = React.createContext<ObservedSize | null>(null);
export const useObservedSize = () => React.useContext(OBSERVED_SIZE)!;

/// Keep the previous size if the dimensions did not change.
/// Resize observers report a new rect object for every observation.
function keepSameSize(prev: ObservedSize | null, next: ObservedSize | null): ObservedSize | null {
    if (prev !== null && next !== null && prev.width === next.width && prev.height === next.height) {
        return prev;
    }
    return next;
}

export const observeSize = (target: React.RefObject<HTMLElement | null>, enabled: boolean = true): ObservedSize | null => {
    const [size, setSize] = React.useState<ObservedSize | null>(null);
    React.useLayoutEffect(() => {
        const next = target.current?.getBoundingClientRect() ?? null;
        setSize(prev => keepSameSize(prev, next));
    }, [target.current]);
    useResizeObserver(enabled ? target : null, (entry: ResizeObserverEntry) => {
        setSize(prev => keepSameSize(prev, entry.contentRect));
    });
    return size;
};

interface ObserverProps {
    children: React.ReactElement;
    disableWidth?: boolean;
    disableHeight?: boolean;
}

export const SizeObserver: React.FC<ObserverProps> = (props: ObserverProps) => {
    const target = React.useRef(null);
    const size = observeSize(target);
    return (
        <div
            ref={target}
            style={{ width: props.disableWidth ? 'auto' : '100%', height: props.disableHeight ? 'auto' : '100%' }}
        >
            <OBSERVED_SIZE.Provider value={size}>{props.children}</OBSERVED_SIZE.Provider>
        </div>
    );
};
