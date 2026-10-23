import * as React from 'react';

/// Stops a writer of the app storage before the app is handed over to another tab
export type AppHandOverHook = () => Promise<void>;

/// Registers a hand over hook and returns its unregistration
export type AppHandOverRegistry = (hook: AppHandOverHook) => () => void;

export const APP_HAND_OVER_CTX = React.createContext<AppHandOverRegistry | null>(null);

/// Stop a writer of the app storage before another tab takes over the app.
/// A no-op outside of an `AppOwnershipGate`.
export function useAppHandOver(hook: AppHandOverHook): void {
    const register = React.useContext(APP_HAND_OVER_CTX);
    const latest = React.useRef(hook);
    latest.current = hook;
    React.useEffect(() => register?.(() => latest.current()), [register]);
}
