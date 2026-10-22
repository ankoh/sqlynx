import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const commandDispatch = vi.fn();

import { ConnectionHealth, type ConnectionState } from '../../connections/connection_state.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR } from '../../connections/connector_info.js';
import { ConnectionCommandList, type ConnectionCommandListDependencies } from './session_command_lists.js';

const dependencies: ConnectionCommandListDependencies = {
    StatusIndicator: () => <span data-testid="status-indicator" />,
    useSessionCommandDispatch: () => commandDispatch,
};

function createConnection(currentFullRefresh: number | null, runningTaskIds: number[]): ConnectionState {
    return {
        connectionHealth: ConnectionHealth.ONLINE,
        connectorInfo: {
            features: {
                executeQueryAction: true,
                refreshSchemaAction: true,
                healthChecks: false,
            },
            icons: { outlines: 'connector' },
        },
        catalogUpdates: {
            currentFullRefresh,
            tasksRunning: new Map(runningTaskIds.map(taskId => [taskId, {}])),
        },
    } as unknown as ConnectionState;
}

describe('ConnectionCommandList', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        commandDispatch.mockClear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function renderConnection(connection: ConnectionState) {
        act(() => {
            root.render(<ConnectionCommandList conn={connection} sessionScripts={null} dependencies={dependencies} />);
        });
        return Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Catalog'))!;
    }

    it('shows an actionable refresh icon while idle', () => {
        const refresh = renderConnection(createConnection(null, []));

        expect(refresh.textContent).toContain('Refresh Catalog');
        expect(refresh.disabled).toBe(false);
        expect(refresh.getAttribute('aria-busy')).toBe('false');
        expect(refresh.querySelector('[data-testid="status-indicator"]')).toBeNull();

        act(() => refresh.click());
        expect(commandDispatch).toHaveBeenCalledWith(2);
    });

    it('executes the script from the sidebar action', () => {
        renderConnection(createConnection(null, []));

        const executeButton = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Execute Script'));
        expect(executeButton).toBeDefined();
        expect(executeButton?.textContent).toContain('Ctrl + E');
        act(() => executeButton?.click());
        expect(commandDispatch).toHaveBeenCalledWith(1);
    });

    it('hides connection health for the embedded connection', () => {
        const connection = createConnection(null, []);
        connection.connectorInfo = CONNECTOR_INFOS[ConnectorType.HYPER];
        connection.details = {
            type: HYPER_CONNECTOR,
            value: {
                proto: { setupParams: { protocol: 'WASM' } },
                channel: null,
            },
        } as ConnectionState['details'];

        renderConnection(connection);

        const editConnection = Array.from(container.querySelectorAll('button'))
            .find(button => button.textContent?.includes('Edit Attached Database'))!;
        expect(editConnection.querySelector('circle')).toBeNull();
    });

    it('shows a disabled loading indicator without changing the label while refreshing', () => {
        const refresh = renderConnection(createConnection(7, [7]));

        expect(refresh.textContent).toContain('Refresh Catalog');
        expect(refresh.textContent).not.toContain('Refreshing Catalog');
        expect(refresh.disabled).toBe(true);
        expect(refresh.getAttribute('aria-busy')).toBe('true');
        expect(refresh.querySelector('[data-testid="status-indicator"]')).not.toBeNull();
    });

    it('returns to the refresh action after completion', () => {
        const refresh = renderConnection(createConnection(7, []));

        expect(refresh.textContent).toContain('Refresh Catalog');
        expect(refresh.disabled).toBe(false);
        expect(refresh.querySelector('[data-testid="status-indicator"]')).toBeNull();
    });
});
