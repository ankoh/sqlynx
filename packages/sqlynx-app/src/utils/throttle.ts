import * as React from 'react';

type DependencyList = readonly any[];

export function useThrottledMemo<T>(factory: () => T, deps: DependencyList, intervalMs = 500): T {
    const [throttledValue, setThrottledValue] = React.useState<T>(() => factory());
    const lastExecuted = React.useRef<number>(Date.now());

    React.useEffect(() => {
        if (Date.now() >= lastExecuted.current + intervalMs) {
            lastExecuted.current = Date.now()
            const value = factory();
            setThrottledValue(value)
            return undefined;
        } else {
            const timerId = setTimeout(() => {
                lastExecuted.current = Date.now()
                const value = factory();
                setThrottledValue(value);
            }, intervalMs);
            return () => clearTimeout(timerId);
        }
    }, deps);

    return throttledValue;
}
