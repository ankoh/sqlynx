import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../platform/logger/logger.js';
import { ConnectionHealth, type AttachedDatabaseState } from '../connections/attached_database_state.js';
import type { HyperSetupApi } from '../connections/hyper/hyper_connection_setup.js';
import { cancelInitialMemorySetup, useInitialMemorySetup } from './initial_memory_setup.js';

describe('initial Memory setup', () => {
    let container: HTMLDivElement;
    let root: Root;
    let database: AttachedDatabaseState;
    let setup: HyperSetupApi;
    const dispatch = vi.fn();
    const logger = { warn: vi.fn() } as unknown as Logger;

    function Consumer(props: { sessionId: string | null; database: AttachedDatabaseState | null }) {
        useInitialMemorySetup(props.sessionId, props.database, setup, dispatch, logger);
        return <div>Session visible</div>;
    }

    async function render(next = database, sessionId: string | null = 'session') {
        await act(async () => {
            root.render(<Consumer database={next} sessionId={sessionId} />);
            await Promise.resolve();
        });
    }

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        database = {
            databaseId: 'memory',
            connectionHealth: ConnectionHealth.NOT_STARTED,
            params: { hyper: { protocol: 'WASM', endpoint: '' } },
            details: { value: { proto: { setupParams: { protocol: 'V3_HTTP' } } } },
        } as unknown as AttachedDatabaseState;
        setup = { setup: vi.fn().mockResolvedValue(null), reset: vi.fn() };
        dispatch.mockReset();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('uses committed Memory params and never reconnects after disconnect or reselection', async () => {
        await render();
        expect(setup.setup).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ protocol: 'WASM' }), expect.any(AbortSignal));
        await render({ ...database, connectionHealth: ConnectionHealth.ONLINE });
        await render({ ...database, connectionHealth: ConnectionHealth.NOT_STARTED });
        await render(database, null);
        await render();
        expect(setup.setup).toHaveBeenCalledTimes(1);
    });

    it.each(['draft', 'committed HTTP', 'already online', 'cancelled'] as const)('does not start for %s on initial selection or later reset', async reason => {
        const httpParams = { hyper: {
            protocol: 'V3_HTTP' as const, endpoint: 'https://hyper',
            tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
        } };
        const first = reason === 'draft'
            ? { ...database, paramsDraft: httpParams }
            : reason === 'committed HTTP'
                ? { ...database, params: httpParams }
                : { ...database, connectionHealth: reason === 'cancelled' ? ConnectionHealth.CANCELLED : ConnectionHealth.ONLINE };
        await render(first);
        await render(database);
        expect(setup.setup).not.toHaveBeenCalled();
    });

    it('starts each newly selected database once without blocking session visibility', async () => {
        setup.setup = vi.fn<HyperSetupApi['setup']>(() => new Promise(() => {}));
        await render();
        expect(container.textContent).toBe('Session visible');
        await render({ ...database, databaseId: 'second-memory' }, 'second-session');
        await render();
        expect(setup.setup).toHaveBeenCalledTimes(2);
    });

    it('cancels the registered startup signal without creating another controller', async () => {
        let signal!: AbortSignal;
        setup.setup = vi.fn<HyperSetupApi['setup']>((_dispatch, _params, abort) => {
            signal = abort;
            return new Promise((_resolve, reject) => abort.addEventListener('abort', () => reject(abort.reason), { once: true }));
        });
        await render();
        expect(cancelInitialMemorySetup('memory')).toBe(true);
        expect(signal.aborted).toBe(true);
        expect(signal.reason.name).toBe('AbortError');
        await render({ ...database, connectionHealth: ConnectionHealth.CANCELLED });
        await render();
        expect(setup.setup).toHaveBeenCalledTimes(1);
        expect(cancelInitialMemorySetup('memory')).toBe(false);
    });
});
