import * as React from 'react';

import { useSessionScriptsRegistry } from '../scripts/session_scripts_registry.js';

/// The name of a session, its id if it has none
export function SessionName(props: { sessionId: string }): React.ReactElement {
    const [scriptsRegistry] = useSessionScriptsRegistry();
    return <>{scriptsRegistry.sessionScriptsMap.get(props.sessionId)?.name?.trim() || props.sessionId}</>;
}

/// Render the name of a session
export const renderSessionName = (sessionId: string) => <SessionName sessionId={sessionId} />;
