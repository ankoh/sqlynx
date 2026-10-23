import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionHealth, type ConnectionState } from '../connection_state.js';
import { CONNECTOR_INFOS, ConnectorType, HYPER_CONNECTOR, TRINO_CONNECTOR } from '../connector_info.js';
import { ConnectionTree } from './connection_tree.js';
import * as styles from './connection_tree.module.css';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

/// A catalog with a single database
const catalog = {
    createSnapshot: () => ({
        read: () => ({
            readName: () => 'hyper',
            catalogReader: {
                databasesLength: () => 1,
                schemasLength: () => 0,
                databases: () => ({ nameId: () => 0, childBegin: () => 0, childCount: () => 0 }),
            },
        }),
    }),
};

function connection(connectionId: string, connector: ConnectorType.HYPER | ConnectorType.TRINO): ConnectionState {
    return {
        connectionId,
        connectionHealth: ConnectionHealth.ONLINE,
        connectorInfo: CONNECTOR_INFOS[connector],
        details: connector === ConnectorType.HYPER
            ? { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'V3_HTTP' } } } }
            : { type: TRINO_CONNECTOR, value: { proto: { setupParams: {} } } },
        catalog,
        catalogUpdates: { currentFullRefresh: null, tasksRunning: new Map() },
    } as unknown as ConnectionState;
}

describe('ConnectionTree sections', () => {
    let container: HTMLDivElement;
    let root: Root;
    const hyper = connection('hyper-1', ConnectorType.HYPER);
    const trino = connection('trino-1', ConnectorType.TRINO);

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function render(props: Partial<React.ComponentProps<typeof ConnectionTree>> = {}): void {
        act(() => root.render(
            <ConnectionTree
                databases={[hyper, trino]}
                onOpenSettings={vi.fn()}
                initiallyExpanded={() => true}
                {...props}
            />,
        ));
    }

    function query(label: string): HTMLButtonElement | null {
        return container.querySelector(`[aria-label="${label}"]`);
    }

    it('offers an overview for Hyper connections only and refreshes the catalog from the catalog row', () => {
        const onOpenOverview = vi.fn();
        render({ onOpenOverview });

        expect(query('Overview of Hyper Http')).not.toBeNull();
        expect(query('Overview of Trino Http')).toBeNull();
        expect(query('Collapse Catalog of Hyper Http')).not.toBeNull();
        expect(query('Collapse Catalog of Trino Http')).not.toBeNull();

        // The refresh button moved from the connection row to the catalog row
        const refresh = query('Refresh catalog for Hyper Http')!;
        expect(refresh.closest(`.${styles.section_row}`)).not.toBeNull();

        act(() => query('Overview of Hyper Http')!.click());
        expect(onOpenOverview).toHaveBeenCalledWith('hyper-1');
    });

    it('marks the open overview and hides overviews without a handler', () => {
        render({ onOpenOverview: vi.fn(), openOverviewId: 'hyper-1' });
        expect(query('Overview of Hyper Http')!.getAttribute('aria-current')).toBe('page');

        render();
        expect(query('Overview of Hyper Http')).toBeNull();
    });

    it('collapses the catalog tree below the catalog row', () => {
        render();
        const catalogNodes = () => Array.from(container.querySelectorAll(`.${styles.catalog_row}`)).length;
        expect(catalogNodes()).toBe(2);

        act(() => query('Collapse Catalog of Hyper Http')!.click());
        expect(catalogNodes()).toBe(1);
        expect(query('Expand Catalog of Hyper Http')).not.toBeNull();

        act(() => query('Collapse Hyper Http')!.click());
        expect(query('Expand Catalog of Hyper Http')).toBeNull();
    });
});
