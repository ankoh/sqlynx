import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach } from 'vitest';

import { LoggerProvider } from '../../../../platform/logger/logger_provider.js';
import { CONNECTOR_INFOS, ConnectorType } from '../connector_info.js';
import { ConnectionHealth, ConnectionStatus, type AttachedDatabaseState } from '../attached_database_state.js';
import { ConnectionInlineHeader } from './connection_inline_header.js';

describe('ConnectionInlineHeader', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('offers selection with an embedded engine label instead of health status', () => {
        const connection = {
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
            connectionHealth: ConnectionHealth.NOT_STARTED,
            connectionStatus: ConnectionStatus.NOT_STARTED,
            details: { type: Symbol('test'), value: null },
        } as unknown as AttachedDatabaseState;

        act(() => root.render(
            <LoggerProvider>
                <ConnectionInlineHeader
                    connector={connection.connectorInfo}
                    connection={connection}
                    wrongPlatform={false}
                    setupConnection={() => {}}
                    notebookScripts={null}
                    embedded
                />
            </LoggerProvider>,
        ));

        expect(container.querySelector('button')?.textContent).toBe('Select');
        expect(container.querySelector('button svg')).toBeNull();
        expect(container.textContent).toContain('Embedded Engine');
        expect(container.textContent).not.toContain('Disconnected');
    });

    it('keeps connect and health status for remote connectors', () => {
        const connection = {
            connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            connectionHealth: ConnectionHealth.NOT_STARTED,
            connectionStatus: ConnectionStatus.NOT_STARTED,
            details: { type: Symbol('test'), value: null },
        } as unknown as AttachedDatabaseState;

        act(() => root.render(
            <LoggerProvider>
                <ConnectionInlineHeader
                    connector={connection.connectorInfo}
                    connection={connection}
                    wrongPlatform={false}
                    setupConnection={() => {}}
                    notebookScripts={null}
                />
            </LoggerProvider>,
        ));

        expect(container.querySelector('button')?.textContent).toBe('Connect');
        expect(container.textContent).toContain('Disconnected');
    });

    it('renders an optional action immediately after the connector name', () => {
        const connector = CONNECTOR_INFOS[ConnectorType.SALESFORCE_DATA_CLOUD];
        act(() => root.render(
            <LoggerProvider>
                <ConnectionInlineHeader
                    connector={connector}
                    connection={null}
                    wrongPlatform={false}
                    setupConnection={() => {}}
                    notebookScripts={null}
                    connectorNameAction={<button type="button">History</button>}
                />
            </LoggerProvider>,
        ));

        const connectorInfo = Array.from(container.querySelectorAll('button'))
            .find(button => button.textContent === 'History')!.parentElement!;
        expect(connectorInfo.children[1].textContent).toBe('Salesforce Data Cloud');
        expect(connectorInfo.children[2].textContent).toBe('History');
    });

    it('places draft actions immediately before Close in the connector header', () => {
        let closed = false;
        act(() => root.render(
            <LoggerProvider>
                <ConnectionInlineHeader
                    connector={CONNECTOR_INFOS[ConnectorType.HYPER]}
                    connection={null}
                    wrongPlatform={false}
                    notebookScripts={null}
                    headerActions={<button aria-label="Discard Changes" />}
                    onClose={() => { closed = true; }}
                />
            </LoggerProvider>,
        ));
        const discard = container.querySelector('[aria-label="Discard Changes"]')!;
        const close = container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
        expect(discard.nextElementSibling).toBe(close);
        act(() => close.click());
        expect(closed).toBe(true);
    });
});
