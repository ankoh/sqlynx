import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlatformFile } from '../../platform/file/file.js';

const state = {
    importPortableBundle: vi.fn(),
    navigate: vi.fn(),
    readSessionBundleFromZip: vi.fn(),
};

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

import { FileLoader, type FileLoaderDependencies } from './file_loader.js';

const dependencies = {
    sessionImportCard: {
        CompactNavBar: () => <></>,
        ParticleFlowBackground: () => <div data-testid="particles" />,
    },
    readSessionBundleFromZip: state.readSessionBundleFromZip,
    useSessionImport: () => ({ importPortableBundle: state.importPortableBundle }),
    useRouterNavigate: () => state.navigate,
} as FileLoaderDependencies;

const BUNDLE = {
    session: {
        formatVersion: 4,
        sessionId: '11111111-2222-4333-8444-555555555555',
        name: 'Explain',
        mainDatabase: { databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: {} } },
        attachedDatabases: [],
        metadata: { originType: 'FILE', originalFileName: 'Explain.dashql' },
    },
    schemaSql: null,
    functionsSql: null,
    scripts: [{ name: '01_query.sql', sql: 'SELECT 1' }],
};

function file(readAsArrayBuffer: PlatformFile['readAsArrayBuffer'] = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]))): PlatformFile {
    return {
        path: '/tmp/Explain.dashql',
        stream: () => new Blob().stream(),
        readAsArrayBuffer,
    };
}

function button(container: HTMLElement, label: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll('button')).find(value => value.textContent === label) ?? null;
}

describe('FileLoader', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        state.importPortableBundle.mockReset().mockResolvedValue('imported-session');
        state.navigate.mockReset();
        state.readSessionBundleFromZip.mockReset().mockResolvedValue(BUNDLE);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    it('validates the file and waits for permission before importing', async () => {
        const onDone = vi.fn();
        await act(async () => root.render(<FileLoader file={file()} onDone={onDone} dependencies={dependencies} />));

        await vi.waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('Import Session'));
        expect(container.querySelector('[data-testid="particles"]')).not.toBeNull();
        expect(container.querySelector('section')?.getAttribute('aria-busy')).toBeNull();
        expect(container.textContent).toContain('Explain');
        expect(container.textContent).toContain('1 script');
        expect(state.importPortableBundle).not.toHaveBeenCalled();

        await act(async () => button(container, 'Import')!.click());

        await vi.waitFor(() => expect(state.importPortableBundle).toHaveBeenCalledOnce());
        expect(state.navigate).toHaveBeenCalledOnce();
        expect(onDone).toHaveBeenCalledOnce();
    });

    it('shows loading phases while reading and validating', async () => {
        let finishRead!: (bytes: Uint8Array) => void;
        let finishValidation!: (bundle: typeof BUNDLE) => void;
        const read = new Promise<Uint8Array>(resolve => { finishRead = resolve; });
        const validation = new Promise<typeof BUNDLE>(resolve => { finishValidation = resolve; });
        state.readSessionBundleFromZip.mockReturnValue(validation);

        act(() => root.render(<FileLoader file={file(() => read)} onDone={() => {}} dependencies={dependencies} />));
        expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
        expect(container.textContent).toContain('Reading session file...');

        await act(async () => {
            finishRead(new Uint8Array([1, 2, 3]));
        });
        await vi.waitFor(() => expect(container.textContent).toContain('Checking the session archive...'));
        expect(container.textContent).toContain('3 bytes');

        await act(async () => finishValidation(BUNDLE));
        await vi.waitFor(() => expect(button(container, 'Import')).not.toBeNull());
    });

    it('ignores a cancelled stale read when callbacks change', async () => {
        let finishRead!: (bytes: Uint8Array) => void;
        const read = new Promise<Uint8Array>(resolve => { finishRead = resolve; });
        const input = file(() => read);
        const onDone = vi.fn();

        act(() => root.render(<FileLoader file={input} onDone={onDone} dependencies={dependencies} />));
        await act(async () => {
            root.render(<FileLoader file={input} onDone={() => onDone()} dependencies={dependencies} />);
            finishRead(new Uint8Array([1, 2, 3]));
        });

        await vi.waitFor(() => expect(button(container, 'Import')).not.toBeNull());
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(state.readSessionBundleFromZip).toHaveBeenCalledOnce();
        expect(state.importPortableBundle).not.toHaveBeenCalled();
    });

    it('shows an accessible validation error and retries', async () => {
        state.readSessionBundleFromZip.mockRejectedValueOnce(new Error('Invalid ZIP: missing dashql-session.json'));
        await act(async () => root.render(<FileLoader file={file()} onDone={() => {}} dependencies={dependencies} />));

        await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
        const alert = container.querySelector('[role="alert"]');
        expect(alert?.textContent).toContain('not a valid DashQL session archive');
        expect(alert?.textContent).toContain('missing dashql-session.json');

        await act(async () => button(container, 'Try Again')!.click());
        await vi.waitFor(() => expect(button(container, 'Import')).not.toBeNull());
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.querySelector('h1')?.textContent).toBe('Import Session');
    });

    it('returns to the permission screen when import is cancelled', async () => {
        state.importPortableBundle.mockResolvedValueOnce(null);
        await act(async () => root.render(<FileLoader file={file()} onDone={() => {}} dependencies={dependencies} />));
        await vi.waitFor(() => expect(button(container, 'Import')).not.toBeNull());
        await act(async () => button(container, 'Import')!.click());

        await vi.waitFor(() => expect(state.importPortableBundle).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(button(container, 'Import')?.disabled).toBe(false));
        expect(container.querySelector('h1')?.textContent).toBe('Import Session');
        expect(button(container, 'Import')).not.toBeNull();
    });

    it('shows import failures without falsely completing the dropzone', async () => {
        const onDone = vi.fn();
        state.importPortableBundle.mockRejectedValueOnce(new Error('Storage is unavailable'));
        await act(async () => root.render(<FileLoader file={file()} onDone={onDone} dependencies={dependencies} />));
        await vi.waitFor(() => expect(button(container, 'Import')).not.toBeNull());
        await act(async () => button(container, 'Import')!.click());

        await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not import this session');
        expect(container.textContent).toContain('Storage is unavailable');
        expect(onDone).not.toHaveBeenCalled();
        expect(state.navigate).not.toHaveBeenCalled();
    });
});
