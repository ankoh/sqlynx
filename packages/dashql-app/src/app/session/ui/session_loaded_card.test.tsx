import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HttpSessionLoadResult } from '../persistence/http_session_bundle.js';
import { SessionImportCard, type SessionImportCardDependencies } from './session_import_card.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const dependencies: SessionImportCardDependencies = {
    CompactNavBar: () => <></>,
    ParticleFlowBackground: () => null,
};

const RESULT: HttpSessionLoadResult = {
    bundle: {
        session: {
            formatVersion: 4,
            sessionId: '11111111-2222-4333-8444-555555555555',
            name: 'Flat session',
            mainDatabase: { databaseId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', params: { hyper: {} } as any },
            attachedDatabases: [],
            metadata: { originType: 'HTTP', originalHttpUrl: 'https://example.com/dashql-session.json' },
        },
        schemaSql: null,
        functionsSql: null,
        scripts: [{ name: '01_query.sql', sql: 'SELECT 1' }],
    },
    indexedScriptCount: 1,
    loadedScriptCount: 1,
    incomplete: false,
};

describe('SessionImportCard V2 ready state', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    it('summarizes flat scripts and starts import', () => {
        const onImport = vi.fn();
        act(() => root.render(<SessionImportCard phase="ready" result={RESULT} conflictLocation={null}
            conflictIsNative={false} busy={false} onImport={onImport} onReplace={() => {}}
            onCreateNew={() => {}} onClose={() => {}} dependencies={dependencies} />));
        expect(container.textContent).toContain('Flat session');
        expect(container.textContent).toContain('1 script in 0 folders');
        const button = Array.from(container.querySelectorAll('button')).find(value => value.textContent === 'Import')!;
        act(() => button.click());
        expect(onImport).toHaveBeenCalledOnce();
    });

    it('surfaces incomplete index state and native replacement safety', () => {
        act(() => root.render(<SessionImportCard phase="ready" result={{ ...RESULT, indexedScriptCount: 3, incomplete: true }}
            conflictLocation="/tmp/native" conflictIsNative busy={false} onImport={() => {}} onReplace={() => {}}
            onCreateNew={() => {}} onClose={() => {}} dependencies={dependencies} />));
        expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);
        expect(container.textContent).toContain('1 of 3 scripts in 0 folders');
        expect(container.textContent).toContain('without overwriting existing native files');
        expect(container.textContent).toContain('Replace');
        expect(container.textContent).toContain('Create New');
    });
});
