import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionBundle } from '../persistence/session_bundle.js';
import { SessionImportCard, type SessionImportCardDependencies } from './session_import_card.js';

const FILE_BUNDLE: SessionBundle = {
    session: {
        formatVersion: 4,
        sessionId: '11111111-2222-4333-8444-555555555555',
        name: 'Local session',
        mainDatabase: {
            databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            params: {
                hyper: {
                    protocol: 'WASM',
                    endpoint: '',
                    tls: { clientKeyPath: '', clientCertPath: '', caCertsPath: '' },
                },
            },
        },
        attachedDatabases: [],
        metadata: { originType: 'FILE', originalFileName: 'local.dashql' },
    },
    schemaSql: null,
    functionsSql: null,
    scripts: [{ name: 'query.sql', sql: 'SELECT 1' }],
};

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const dependencies: SessionImportCardDependencies = {
    CompactNavBar: () => <></>,
    ParticleFlowBackground: () => null,
};

describe('SessionImportCard loading state', () => {
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

    const render = (card: React.ReactElement) => root.render(<MemoryRouter>{card}</MemoryRouter>);

    it('shows indeterminate manifest loading and cancels', () => {
        const onCancel = vi.fn();
        act(() => render(
            <SessionImportCard
                phase="loading"
                sourceUrl="https://example.com/dashql-session.json"
                progress={{ phase: 'manifest' }}
                onClose={onCancel}
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('h1')?.textContent).toBe('Loading Session');
        expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading session manifest');
        expect(container.querySelector('[role="progressbar"]')).toBeNull();
        expect(container.textContent).toContain('https://example.com/dashql-session.json');

        const cancel = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
        act(() => cancel.click());
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it('shows determinate file and script progress after discovery', () => {
        act(() => render(
            <SessionImportCard
                phase="loading"
                sourceUrl="https://example.com/dashql-session.json"
                progress={{
                    phase: 'files',
                    sessionName: 'Example',
                    sessionId: '4f741f53-d76f-4a6d-b1d8-c22aa85bd449',
                    completedFileCount: 5,
                    totalFileCount: 9,
                    completedScriptCount: 2,
                    totalScriptCount: 4,
                }}
                onClose={() => { }}
                dependencies={dependencies}
            />,
        ));

        expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading scripts: 2 of 4');
        const progress = container.querySelector('[role="progressbar"]')!;
        expect(progress.getAttribute('aria-valuenow')).toBe('56');
        expect(progress.getAttribute('aria-valuetext')).toBe('5 of 9 files');
        expect(container.textContent).toContain('Example');
        expect(container.textContent).toContain('4f741f53-d76f-4a6d-b1d8-c22aa85bd449');
    });

    it('uses the shared card for local-file permission and errors', () => {
        const onImport = vi.fn();
        act(() => render(
            <SessionImportCard phase="file-ready" sourcePath="/tmp/local.dashql" fileByteCount={1200}
                bundle={FILE_BUNDLE} busy={false} onImport={onImport} onClose={() => {}} dependencies={dependencies} />,
        ));
        expect(container.querySelector('h1')?.textContent).toBe('Import Session');
        expect(container.textContent).toContain('Local session');
        const importButton = Array.from(container.querySelectorAll('button')).find(value => value.textContent === 'Import')!;
        act(() => importButton.click());
        expect(onImport).toHaveBeenCalledOnce();

        act(() => render(
            <SessionImportCard phase="file-error" sourcePath="/tmp/local.dashql" fileByteCount={1200}
                failedStage="validating" errorMessage="Invalid ZIP" onRetry={() => {}} onClose={() => {}} dependencies={dependencies} />,
        ));
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('not a valid DashQL session archive');
        expect(container.textContent).toContain('Invalid ZIP');
    });
});
