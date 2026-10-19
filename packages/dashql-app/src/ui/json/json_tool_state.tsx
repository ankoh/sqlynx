import * as React from 'react';

type Action = Record<string, boolean>;
type Dispatch = (action: Action) => void;
type Listener = () => void;

/// Hover changes on every mouseenter and mouseleave.
/// We therefore keep the tool visibility in a store that notifies only the copy buttons of the changed nodes,
/// instead of a context value that re-renders every copy button of the tree.
export class ToolVisibilityStore {
    protected visible: Map<string, boolean> = new Map();
    protected listeners: Map<string, Set<Listener>> = new Map();

    public dispatch: Dispatch = (action: Action) => {
        for (const [key, value] of Object.entries(action)) {
            if ((this.visible.get(key) ?? false) === value) {
                continue;
            }
            this.visible.set(key, value);
            for (const listener of this.listeners.get(key) ?? []) {
                listener();
            }
        }
    };
    public subscribe(key: string, listener: Listener): () => void {
        let listeners = this.listeners.get(key);
        if (!listeners) {
            listeners = new Set();
            this.listeners.set(key, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size == 0) {
                this.listeners.delete(key);
            }
        };
    }
    public isVisible(key: string): boolean {
        return this.visible.get(key) ?? false;
    }
}

const Context = React.createContext<ToolVisibilityStore | null>(null);

export function useToolVisibility(key: string): boolean {
    const store = React.useContext(Context);
    const subscribe = React.useCallback((listener: Listener) => store?.subscribe(key, listener) ?? (() => { }), [store, key]);
    const getSnapshot = React.useCallback(() => store?.isVisible(key) ?? false, [store, key]);
    return React.useSyncExternalStore(subscribe, getSnapshot);
}

const noopDispatch: Dispatch = () => { };

export function useToolVisibilityDispatch(): Dispatch {
    return React.useContext(Context)?.dispatch ?? noopDispatch;
}

interface ShowToolsProps {
    store: ToolVisibilityStore;
}

export const ToolVisibilityStateProvider: React.FC<React.PropsWithChildren<ShowToolsProps>> = ({ store, children }) => {
    return <Context.Provider value={store}>{children}</Context.Provider>;
};
