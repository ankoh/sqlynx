import * as React from 'react';

import type { InvalidSession } from '../../storage/session_validation.js';

interface InvalidSessionRegistryValue {
    invalidSessions: ReadonlyMap<string, InvalidSession>;
    deleteInvalidSession: (sessionId: string) => Promise<void>;
}

const InvalidSessionRegistryContext = React.createContext<InvalidSessionRegistryValue>({
    invalidSessions: new Map(),
    deleteInvalidSession: async () => {},
});

export const InvalidSessionRegistryProvider = InvalidSessionRegistryContext.Provider;

export function useInvalidSessionRegistry(): InvalidSessionRegistryValue {
    return React.useContext(InvalidSessionRegistryContext);
}
