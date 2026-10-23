import * as React from 'react';

import { useSaveBeforeConnect } from '../connection_persistence.js';
import { cancelConnectionSetup, registerConnectionSetup } from '../connection_setup_cancellation.js';

/// The setup of a connection from its settings
export interface ConnectionSetup {
    /// Run a setup with the saved settings, unsaved edits are saved first.
    /// The setup receives the signal that cancels it.
    run: (setup: (signal: AbortSignal) => Promise<void>) => Promise<void>;
    /// Cancel the running setup
    cancel: () => void;
}

export function useConnectionSetup(connectionId: string | null): ConnectionSetup {
    const saveBeforeConnect = useSaveBeforeConnect(connectionId);
    const controllerRef = React.useRef<AbortController | null>(null);

    const run = React.useCallback(async (setup: (signal: AbortSignal) => Promise<void>) => {
        // Connections are set up with saved settings, unsaved edits are saved first
        if (!await saveBeforeConnect()) return;
        const controller = new AbortController();
        // The startup and the settings share one cancellation owner per connection
        const unregister = connectionId == null ? () => { } : registerConnectionSetup(connectionId, controller);
        controllerRef.current = controller;
        try {
            await setup(controller.signal);
        } finally {
            unregister();
            if (controllerRef.current === controller) controllerRef.current = null;
        }
    }, [connectionId, saveBeforeConnect]);

    const cancel = React.useCallback(() => {
        if (connectionId != null) cancelConnectionSetup(connectionId);
        controllerRef.current?.abort(new DOMException('Connection setup cancelled', 'AbortError'));
        controllerRef.current = null;
    }, [connectionId]);

    return React.useMemo(() => ({ run, cancel }), [run, cancel]);
}
