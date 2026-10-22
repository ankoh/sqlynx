import * as core from '@ankoh/dashql-core';
import * as Immutable from 'immutable';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../../platform/logger/logger.js';
import { CONNECTOR_INFOS, ConnectorType } from '../connections/connector_info.js';
import { SessionTestBackend } from '../../storage/session_test_backend.js';
import { StorageWriter } from '../../storage/storage_writer.js';
import { deriveFocusFromEditorUpdate } from './focus.js';
import { DashQLCompletionStatus } from './editor/dashql_processor.js';
import {
    APPLY_PLANNER_ANALYSIS,
    createEmptyScriptData,
    type SessionScripts,
    reduceSessionScripts,
    replaceScriptSessionText,
} from './session_scripts.js';
import { createEmptyMetadata, createScriptRef } from './script_types.js';

declare const DASHQL_PRECOMPILED: Promise<Uint8Array>;

class NullLogger extends Logger {
    public destroy(): void {}
    protected flushPendingRecords(): void {}
}

let dql: core.DashQL;
const logger = new NullLogger();

beforeAll(async () => { dql = await core.DashQL.create({ wasmBinary: await DASHQL_PRECOMPILED }); });
afterEach(() => { vi.restoreAllMocks(); dql.resetUnsafe(); });

function fixture() {
    const catalog = dql.createCatalog();
    const scripts: SessionScripts['scripts'] = {};
    const scriptRefs: SessionScripts['scriptRefs'] = {};
    for (const [fileName, text] of [
        ['1_items.sql', 'create table items (id int);'],
        ['2_query.sql', 'select id from items;'],
        ['3_other.sql', 'select 3;'],
    ]) {
        const [scriptKey, script] = createEmptyScriptData(dql, catalog, fileName);
        replaceScriptSessionText(script.scriptSession, text);
        scripts[scriptKey] = script;
        scriptRefs[fileName] = createScriptRef(scriptKey, fileName);
    }
    const state: SessionScripts = {
        instance: dql, sessionId: crypto.randomUUID(), name: 'Test', databaseId: crypto.randomUUID(), settings: { cacheQueryResults: false },
        sessionMetadata: createEmptyMetadata(), connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        connectionCatalog: catalog, scripts, scriptRefs,
        scriptFocus: { fileName: '2_query.sql' }, semanticUserFocus: null,
    };
    const [definition, query, other] = Object.values(scripts);
    // Publish before capturing snapshots, matching the planner's final catalog revision.
    for (const script of [definition, query, other]) {
        script.scriptSession.analyze();
        script.scriptSession.loadIntoCatalog(script.scriptKey);
    }
    const updates = [definition, query].map(script => ({
        scriptKey: script.scriptKey, editorUpdate: script.scriptSession.analyze(),
    }));
    const writer = new StorageWriter(logger, new SessionTestBackend());
    const write = vi.spyOn(writer, 'write');
    const apply = (value = updates, current = state) => reduceSessionScripts(current,
        { type: APPLY_PLANNER_ANALYSIS, value }, writer, logger, true);
    return { state, definition, query, other, updates, write, apply };
}

describe('planner analysis projection', () => {
    it('applies a batch without republishing, invalidating peers, or persisting SQL', () => {
        const f = fixture();
        const sessions = Object.values(f.state.scripts).map(script => script.scriptSession);
        const revisions = sessions.map(session => session.getCatalogRevision());
        const publish = sessions.map(session => vi.spyOn(session, 'loadIntoCatalog'));
        const next = f.apply();

        expect(next.scripts[f.definition.scriptKey].annotations.tableDefs).toEqual(['items']);
        for (const { scriptKey, editorUpdate } of f.updates) {
            const script = next.scripts[scriptKey];
            expect(script.editorUpdate).toBe(editorUpdate);
            expect(script.analysisOutdated).toBe(false);
            expect(script.statistics).toEqual(editorUpdate.analysisUpdated && editorUpdate.processingStatistics != null
                ? Immutable.List([editorUpdate.processingStatistics]) : Immutable.List());
            expect(f.state.scripts[scriptKey].analysisOutdated).toBe(true);
        }
        expect(next.scripts[f.other.scriptKey]).toBe(f.other);
        expect(sessions.map(session => session.getCatalogRevision())).toEqual(revisions);
        publish.forEach(spy => expect(spy).not.toHaveBeenCalled());
        expect(f.write).not.toHaveBeenCalled();
    });

    it('ignores missing scripts and snapshots with stale live text versions', () => {
        const f = fixture();
        replaceScriptSessionText(f.query.scriptSession, 'select 2;');
        expect(f.query.editorUpdate).toBeNull();
        expect(f.apply([
            f.updates[1],
            { scriptKey: -1, editorUpdate: f.updates[0].editorUpdate },
        ])).toBe(f.state);
        expect(f.write).not.toHaveBeenCalled();
    });

    it('ignores snapshots invalidated by a later catalog publication', () => {
        const f = fixture();
        f.other.scriptSession.loadIntoCatalog(f.other.scriptKey);
        expect(f.query.scriptSession.getCatalogRevision()).not.toBe(f.updates[1].editorUpdate.catalogRevision);
        expect(f.apply()).toBe(f.state);
    });

    it('ignores failed or unavailable analysis', () => {
        const f = fixture();
        f.updates[0].editorUpdate.status = core.buffers.editor.EditorUpdateStatus.STALE_TEXT_VERSION;
        f.updates[1].editorUpdate.analysisAvailable = false;
        expect(f.apply()).toBe(f.state);
    });

    it('refreshes a superseded cursor projection and derives focus only for the selected script', () => {
        const f = fixture();
        const cursorUpdate = f.query.scriptSession.setCursor(f.query.scriptSession.getTextVersion(), 8n);
        expect(cursorUpdate.stateRevision).not.toBe(f.updates[1].editorUpdate.stateRevision);
        const expectedFocus = deriveFocusFromEditorUpdate(f.query.scriptKey, cursorUpdate);
        expect(expectedFocus).not.toBeNull();
        // Put the background script last so batch order cannot steal focus.
        const next = f.apply([f.updates[1], f.updates[0]]);
        expect(next.scripts[f.query.scriptKey].editorUpdate?.stateRevision).toBe(cursorUpdate.stateRevision);
        expect(next.scripts[f.query.scriptKey].editorUpdate?.primaryCursorState).toEqual(cursorUpdate.primaryCursorState);
        expect(next.semanticUserFocus).toEqual(expectedFocus);
        expect(next.scriptFocus).toBe(f.state.scriptFocus);
    });

    it('clears stale completion and background focus while preserving query history', () => {
        const f = fixture();
        f.query.scriptSession.setCursor(f.query.scriptSession.getTextVersion(), 8n);
        const cursorUpdate = f.query.scriptSession.analyze();
        const buffer = f.query.scriptSession.completeAtCursor(10);
        const destroy = vi.spyOn(buffer, 'destroy');
        const query = {
            ...f.query,
            completion: {
                status: DashQLCompletionStatus.AVAILABLE, passiveHint: false, buffer,
                candidateId: 0, candidatePatch: [], catalogObjectId: 0,
                catalogObjectPatch: [], catalogObjectCursorOffset: null,
            },
            latestQueryId: 42,
        };
        const current = {
            ...f.state,
            scripts: { ...f.state.scripts, [query.scriptKey]: query },
            semanticUserFocus: deriveFocusFromEditorUpdate(query.scriptKey, cursorUpdate),
        };
        const next = f.apply(f.updates, current);
        expect(destroy).toHaveBeenCalledOnce();
        expect(next.scripts[query.scriptKey].completion).toBeNull();
        expect(next.scripts[query.scriptKey].pendingDiff).toBe(query.pendingDiff);
        expect(next.scripts[query.scriptKey].latestQueryId).toBe(42);
        expect(next.semanticUserFocus).toEqual(deriveFocusFromEditorUpdate(query.scriptKey,
            next.scripts[query.scriptKey].editorUpdate));

        expect(f.apply([f.updates[0]], current).semanticUserFocus).toBeNull();
    });
});
