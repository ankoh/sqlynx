import * as React from 'react';

/// A state container outside of React.
///
/// React may invoke the updater of a state hook more than once, e.g. when it rebases updates or
/// double-invokes them in strict mode. The registries free Wasm objects and schedule storage writes
/// while they reduce, so their updates must run exactly once. A store applies every update right
/// away, synchronously and in call order, and notifies its subscribers afterwards.
export class Store<T> {
    /// The current state
    current: T;
    /// The subscribers
    private readonly listeners: Set<() => void>;

    constructor(initial: T) {
        this.current = initial;
        this.listeners = new Set();
    }

    /// Subscribe to state changes
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    /// Get the current state
    get = (): T => this.current;

    /// Replace the state or derive it from the current one. The updater runs exactly once.
    update = (action: React.SetStateAction<T>): void => {
        const next = typeof action === 'function'
            ? (action as (prev: T) => T)(this.current)
            : action;
        if (Object.is(next, this.current)) return;
        this.current = next;
        for (const listener of this.listeners) {
            listener();
        }
    };
}

/// Batches the updates of a store and applies them in a single store update, in the order they were pushed.
///
/// Updates are applied at the end of the current task. Updates that may wait for the next frame, e.g.
/// the progress of a result stream, are applied once per frame. An update that must not wait applies
/// the queued updates right away to preserve their order.
export class UpdateQueue<T> {
    /// The store
    private readonly store: Store<T>;
    /// The pending updates
    private pending: Array<(state: T) => T>;
    /// The scheduled flush
    private scheduled: { type: 'microtask' } | { type: 'frame'; handle: number } | null;

    constructor(store: Store<T>) {
        this.store = store;
        this.pending = [];
        this.scheduled = null;
    }

    /// Queue an update
    push(update: (state: T) => T, waitForFrame: boolean = false): void {
        this.pending.push(update);
        if (waitForFrame) {
            if (this.scheduled == null) {
                this.scheduled = { type: 'frame', handle: requestAnimationFrame(this.flush) };
            }
        } else if (this.scheduled?.type === 'frame') {
            cancelAnimationFrame(this.scheduled.handle);
            this.flush();
        } else if (this.scheduled == null) {
            this.scheduled = { type: 'microtask' };
            queueMicrotask(this.flush);
        }
    }

    /// Apply the pending updates
    flush = (): void => {
        this.scheduled = null;
        const pending = this.pending;
        if (pending.length === 0) return;
        this.pending = [];
        this.store.update(state => pending.reduce((s, update) => update(s), state));
    };

    /// Drop the pending updates
    dispose(): void {
        if (this.scheduled?.type === 'frame') {
            cancelAnimationFrame(this.scheduled.handle);
        }
        this.scheduled = null;
        this.pending = [];
    }
}

/// Create the update queue of a store that lives as long as the component
export function useUpdateQueue<T>(store: Store<T>): UpdateQueue<T> {
    const [queue] = React.useState(() => new UpdateQueue(store));
    React.useEffect(() => () => queue.dispose(), [queue]);
    return queue;
}

/// Create a store that lives as long as the component
export function useStore<T>(initial: () => T): Store<T> {
    const [store] = React.useState(() => new Store(initial()));
    return store;
}

/// Subscribe to the state of a store
export function useStoreState<T>(store: Store<T>): T {
    return React.useSyncExternalStore(store.subscribe, store.get);
}
