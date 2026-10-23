import * as React from 'react';

import type { ConnectionState } from '../../connections/connection_state.js';
import { useConnectionReferences, useConnectionRegistryStore } from '../../connections/connection_registry.js';
import { connectionLabelParts, connectionOrdinals, type ConnectionLabelParts } from '../../connections/ui/connection_label.js';
import { useSessionScriptsRegistry } from '../scripts/session_scripts_registry.js';

const subscribeNever = () => () => {};

/// The ordinals that tell unnamed connections of the same connector apart, see `connectionOrdinals`.
/// The map keeps its identity while the ordinals are unchanged.
export function useConnectionOrdinals(): ReadonlyMap<string, number> {
    // Re-number when the sessions use other connections
    const [scripts] = useSessionScriptsRegistry();
    const references = useConnectionReferences();
    // The registry changes with every query, the selector returns a string to compare by value
    const selectKey = React.useCallback(
        (registry: Parameters<typeof connectionOrdinals>[0]) => [...connectionOrdinals(registry, references)]
            .map(([connectionId, ordinal]) => `${connectionId}=${ordinal}`)
            .join(','),
        [references, scripts],
    );
    // Views outside of a connection registry (e.g. in tests) number no connections
    const store = useConnectionRegistryStore();
    const key = React.useSyncExternalStore(store?.subscribe ?? subscribeNever, () => store == null ? '' : selectKey(store.current));
    return React.useMemo(() => new Map(key.length === 0 ? [] : key.split(',').map(entry => {
        const [connectionId, ordinal] = entry.split('=');
        return [connectionId, Number(ordinal)] as const;
    })), [key]);
}

/// Label connections with their names, unnamed connections with their ordinals
export function useConnectionLabeler(): (database: ConnectionState) => ConnectionLabelParts {
    const ordinals = useConnectionOrdinals();
    return React.useCallback(
        (database: ConnectionState) => connectionLabelParts(database, ordinals.get(database.connectionId) ?? null),
        [ordinals],
    );
}
