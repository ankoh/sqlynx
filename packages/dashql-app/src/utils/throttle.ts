import * as React from 'react';

type DependencyList = readonly any[];

export function useThrottledMemo<T>(value: T, deps: DependencyList, intervalMs = 500): T {
    const [throttledValue, setThrottledValue] = React.useState<T>(() => value);
    const latestFactory = React.useRef<T | null>(null);
    const lastExecuted = React.useRef<number>(Date.now());
    latestFactory.current = value;

    React.useEffect(() => {
        if (Date.now() >= lastExecuted.current + intervalMs) {
            lastExecuted.current = Date.now()
            setThrottledValue(latestFactory.current!)
            return undefined;
        } else {
            const timerId = setTimeout(() => {
                lastExecuted.current = Date.now()
                setThrottledValue(latestFactory.current!);
            }, intervalMs);
            return () => clearTimeout(timerId);
        }
    }, deps);

    return throttledValue;
}
