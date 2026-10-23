import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionHealth, type ConnectionState } from '../connection_state.js';

const refreshCatalog = vi.fn();

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

import {
    ConnectionRefreshButton,
    ConnectionRowMenu,
    type ConnectionRefreshDependencies,
} from './connection_tree.js';

const dependencies: ConnectionRefreshDependencies = {
    useCatalogLoaderQueue: () => refreshCatalog,
};

function database(): ConnectionState {
    return {
        connectionId: 'database-1',
        connectionHealth: ConnectionHealth.ONLINE,
        catalogUpdates: {
            currentFullRefresh: null,
            tasksRunning: new Map(),
        },
    } as ConnectionState;
}

describe('ConnectionRowMenu', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        refreshCatalog.mockReset();
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function renderMenu(onOpenSettings = vi.fn()) {
        act(() => root.render(
            <ConnectionRowMenu
                database={database()}
                label="Hyper / WASM"
                onOpenSettings={onOpenSettings}
                dependencies={dependencies}
            />,
        ));
        act(() => {
            (container.querySelector('[aria-label="More actions for Hyper / WASM"]') as HTMLButtonElement).click();
        });
        return onOpenSettings;
    }

    function clickAction(label: string): void {
        act(() => {
            Array.from(document.querySelectorAll('button')).find(button => button.textContent === label)!.click();
        });
    }

    it('opens connection settings from the intermediary menu', () => {
        const onOpenSettings = renderMenu();
        clickAction('Settings');

        expect(onOpenSettings).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
    });

    it('forces a catalog refresh from the intermediary menu', () => {
        renderMenu();
        clickAction('Refresh');

        expect(refreshCatalog).toHaveBeenCalledWith('database-1', true);
    });

    it('also exposes the inline catalog refresh action', () => {
        act(() => root.render(
            <ConnectionRefreshButton database={database()} label="Hyper / WASM" dependencies={dependencies} />,
        ));
        act(() => {
            (container.querySelector('[aria-label="Refresh catalog for Hyper / WASM"]') as HTMLButtonElement).click();
        });

        expect(refreshCatalog).toHaveBeenCalledWith('database-1', true);
    });
});
