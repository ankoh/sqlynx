import * as React from 'react';
import useResizeObserver from '@react-hook/resize-observer';

export interface ObservedSize {
    width: number;
    height: number;
}

export const OBSERVED_SIZE = React.createContext<ObservedSize | null>(null);
export const useObservedSize = () => React.useContext(OBSERVED_SIZE)!;

export const observeSize = (target: React.RefObject<HTMLElement>): ObservedSize | null => {
    const [size, setSize] = React.useState<ObservedSize | null>(null);
    React.useLayoutEffect(() => {
        setSize(
            target.current?.getBoundingClientRect() ?? {
                width: 1000,
                height: 1000,
            },
        );
    }, [target]);
    useResizeObserver(target, (entry: ResizeObserverEntry) => setSize(entry.contentRect));
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
