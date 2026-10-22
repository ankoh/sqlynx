import * as React from 'react';
import { ConnectionHealth } from '../../connections/connection_state.js';
import { Tooltip } from '../../../ui/foundations/tooltip.js';

export const CONNECTION_ATTENTION_DURATION_MS = 900;

interface ConnectionAttention {
    sessionId: string | null;
    active: boolean;
    request: (sessionId: string) => void;
}

export const SessionConnectionAttentionContext = React.createContext<ConnectionAttention | null>(null);

export function useSessionConnectionAttention(sessionId: string | null, databaseId: string | null, health: ConnectionHealth | undefined): ConnectionAttention {
    const shared = React.useContext(SessionConnectionAttentionContext);
    const [active, setActive] = React.useState(false);
    const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useLayoutEffect(() => {
        setActive(false);
        if (timer.current != null) clearTimeout(timer.current);
        timer.current = null;
        return () => {
            if (timer.current != null) clearTimeout(timer.current);
            timer.current = null;
        };
    }, [sessionId, databaseId, health]);
    const request = React.useCallback((targetSessionId: string) => {
        if (targetSessionId !== sessionId || health === ConnectionHealth.ONLINE || timer.current != null) return;
        setActive(true);
        timer.current = setTimeout(() => {
            timer.current = null;
            setActive(false);
        }, CONNECTION_ATTENTION_DURATION_MS);
    }, [sessionId, health]);
    // The value is provided as context to every execute button in the feed, keep it stable
    const own = React.useMemo(() => ({ sessionId, active, request }), [sessionId, active, request]);
    return shared?.sessionId === sessionId ? shared : own;
}

export function ExecuteConnectionGuard(props: { sessionId: string; blocked: boolean; children: React.ReactElement }) {
    const attention = React.useContext(SessionConnectionAttentionContext);
    return <Tooltip type="description" direction="s" text={props.blocked ? 'Connect to execute queries' : 'Query execution control'}>
        <span data-execution-connection-blocked={props.blocked ? 'true' : undefined}
            style={{ display: 'inline-flex' }} tabIndex={props.blocked ? 0 : undefined}
            onPointerOverCapture={event => {
                if (props.blocked && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
                    attention?.request(props.sessionId);
                }
            }}>
            {props.children}
        </span>
    </Tooltip>;
}
