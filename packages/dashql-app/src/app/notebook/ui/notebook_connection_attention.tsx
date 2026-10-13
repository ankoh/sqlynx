import * as React from 'react';
import { ConnectionHealth } from '../connections/attached_database_state.js';
import { Tooltip } from '../../../ui/foundations/tooltip.js';

export const CONNECTION_ATTENTION_DURATION_MS = 900;

interface ConnectionAttention {
    notebookId: string | null;
    active: boolean;
    request: (notebookId: string) => void;
}

export const NotebookConnectionAttentionContext = React.createContext<ConnectionAttention | null>(null);

export function useNotebookConnectionAttention(notebookId: string | null, databaseId: string | null, health: ConnectionHealth | undefined): ConnectionAttention {
    const shared = React.useContext(NotebookConnectionAttentionContext);
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
    }, [notebookId, databaseId, health]);
    const request = React.useCallback((targetNotebookId: string) => {
        if (targetNotebookId !== notebookId || health === ConnectionHealth.ONLINE || timer.current != null) return;
        setActive(true);
        timer.current = setTimeout(() => {
            timer.current = null;
            setActive(false);
        }, CONNECTION_ATTENTION_DURATION_MS);
    }, [notebookId, health]);
    return shared?.notebookId === notebookId ? shared : { notebookId, active, request };
}

export function ExecuteConnectionGuard(props: { notebookId: string; blocked: boolean; children: React.ReactElement }) {
    const attention = React.useContext(NotebookConnectionAttentionContext);
    return <Tooltip type="description" direction="s" text={props.blocked ? 'Connect to execute queries' : 'Query execution control'}>
        <span data-execution-connection-blocked={props.blocked ? 'true' : undefined}
            style={{ display: 'inline-flex' }} tabIndex={props.blocked ? 0 : undefined}
            onPointerOverCapture={event => {
                if (props.blocked && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
                    attention?.request(props.notebookId);
                }
            }}>
            {props.children}
        </span>
    </Tooltip>;
}
