import * as React from 'react';

type StatePredicate<V> = (v: V) => boolean;

interface StateChangeSubscriber<V> {
    predicate: StatePredicate<V>;
    resolve: (v: V) => void;
    reject: (err: Error) => void;
}

export function useAwaitStateChange<V>(state: V) {
    const subscribers = React.useRef<StateChangeSubscriber<V>[]>([]);

    // Helper to await a state change
    const awaitStateChange = React.useCallback((predicate: StatePredicate<V>) => {
        let resolver: any = null;
        let rejecter: any = null;
        let promise = new Promise((resolve, reject) => {
            resolver = resolve;
            rejecter = reject
        });
        subscribers.current.push({
            predicate,
            resolve: resolver,
            reject: rejecter
        });
        return promise;
    }, []);

    // Check if any of the predicates can be resolved after the state changes
    React.useEffect(() => {
        let filtered: StateChangeSubscriber<V>[] = [];
        for (let i = 0; i < subscribers.current.length; ++i) {
            const sub = subscribers.current[i];
            if (sub.predicate(state)) {
                sub.resolve(state);
            } else {
                filtered.push(sub);
            }
        }
        subscribers.current = filtered;
    }, [state]);

    return awaitStateChange;
}
