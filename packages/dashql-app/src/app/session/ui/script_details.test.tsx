import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionHealth } from '../../connections/connection_state.js';
import { ConnectorType } from '../../connections/connector_info.js';
import * as dashql from '@ankoh/dashql-core';
import { DELETE_SCRIPT, RENAME_SCRIPT, SET_SCRIPT_TEXT, type SessionScripts } from '../scripts/session_scripts.js';
import { runSessionScript } from './rerun_query.js';
import { ScriptDetails, type ScriptDetailsDependencies } from './script_details.js';
import { SessionConnectionAttentionContext } from './session_connection_attention.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const state = { keyHandlers: [] as any[], executeQuery: vi.fn(), formatScriptEditor: vi.fn(), deleteCache: vi.fn(), outputProps: null as any };
const dependencies = {
    useAppConfig: () => ({ settings: {} }),
    useLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    useKeyEvents: (handlers: any[]) => {
        React.useEffect(() => { state.keyHandlers = handlers; }, [handlers]);
    },
    useQueryState: () => null,
    useCancelQuery: () => vi.fn(),
    useQueryExecutor: () => state.executeQuery,
    useStorageReader: () => ({ backend: { deleteQueryResultCache: state.deleteCache } }),
    isScriptFormattable: () => true,
    formatScriptEditor: (...args: any[]) => {
        state.formatScriptEditor(...args);
        args[3]('SELECT 2;');
    },
    runSessionScript,
    ScriptDetailsEditorPane: (props: any) => {
        React.useEffect(() => props.onEditorView({ focus: vi.fn() }), [props.onEditorView]);
        return <div>
            <button aria-label="Rename script" onClick={props.onStartEditingName}>rename</button>
            <button aria-label="Shrink script details" onClick={props.onHide}>shrink</button>
            {props.formatMenu}
            {props.isEditingName ? <input
                ref={props.editInputRef}
                value={props.draftFileName}
                onChange={(event: any) => props.onDraftFileNameChange(event.target.value)}
                onKeyDown={(event: any) => event.key === 'Enter' && props.onSaveName()}
            /> : null}
            <div data-testid="details-editor">{props.scriptDisplay}</div>
        </div>;
    },
    ScriptDetailsOutputPane: (props: any) => { state.outputProps = props; return <div data-testid="output-pane" />; },
    VerticalSplit: (props: any) => <div>{props.first}{props.second}</div>,
} as unknown as ScriptDetailsDependencies;

function scripts(): SessionScripts {
    const scriptSession = {
        getText: () => 'SELECT 2', isFullyFormattable: () => true, compileQuery: () => ({
            read: () => ({ errorsLength: () => 0, sql: () => 'SELECT 2', cacheSignature: () => 'signature', cacheable: () => true }),
            destroy: () => {},
        }), startExecution: () => ({}),
    };
    return {
        sessionId: 'session', name: 'Test', databaseId: 'database', settings: { cacheQueryResults: true }, instance: {} as any, sessionMetadata: {} as any,
        connectorInfo: { connectorType: ConnectorType.TRINO } as any, connectionCatalog: {} as any,
        scripts: { 1: { scriptKey: 1, fileName: '01_first.sql', scriptSession, analysisOutdated: false, annotations: {}, latestQueryId: null } as any,
            2: { scriptKey: 2, fileName: '02_second.sql', scriptSession, analysisOutdated: false, annotations: {}, latestQueryId: null } as any },
        scriptRefs: {
            '01_first.sql': { scriptId: 1, fileName: '01_first.sql' },
            '02_second.sql': { scriptId: 2, fileName: '02_second.sql' },
        },
        scriptFocus: { fileName: '01_first.sql' }, semanticUserFocus: null,
    };
}

describe('ScriptDetails V2 flat scripts', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => { state.keyHandlers = []; state.executeQuery.mockReset().mockReturnValue([42, Promise.resolve()]); state.formatScriptEditor.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    it('pins a flat script by id rather than current focus', () => {
        act(() => root.render(<ScriptDetails sessionScripts={scripts()} modifySessionScripts={vi.fn()}
            connection={null} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />));
        expect(container.textContent).toContain('second');
        expect(container.querySelector('[data-testid="details-editor"]')).not.toBeNull();
    });

    it('renames with the raw flat filename and clean requested name', () => {
        const modify = vi.fn();
        act(() => root.render(<ScriptDetails sessionScripts={scripts()} modifySessionScripts={modify}
            connection={null} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />));
        const edit = container.querySelector('[aria-label="Rename script"]') as HTMLButtonElement;
        act(() => edit.click());
        const input = container.querySelector('input') as HTMLInputElement;
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            setter.call(input, 'report');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(modify).toHaveBeenCalledWith({ type: RENAME_SCRIPT, value: { fileName: '02_second.sql', newFileName: 'report' } });
    });

    it('executes the pinned script from Ctrl+E', () => {
        const modify = vi.fn();
        const connection = { connectionId: 'database', connectionHealth: ConnectionHealth.ONLINE } as any;
        act(() => root.render(<ScriptDetails sessionScripts={scripts()} modifySessionScripts={modify}
            connection={connection} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />));
        const handler = state.keyHandlers.find(value => value.key === 'e' && value.ctrlKey === true);
        expect(handler).toBeDefined();
        act(() => handler.callback({ preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }));
        expect(state.executeQuery).toHaveBeenCalledWith('database', expect.objectContaining({ query: 'SELECT 2' }));
    });

    it('blocks pinned Ctrl+E and cached reruns before cache deletion while main is offline', async () => {
        const request = vi.fn();
        state.deleteCache.mockReset().mockResolvedValue(undefined);
        const connection = { connectionId: 'main', connectionHealth: ConnectionHealth.FAILED } as any;
        act(() => root.render(<SessionConnectionAttentionContext.Provider value={{ sessionId: 'session', active: false, request }}>
            <ScriptDetails sessionScripts={scripts()} modifySessionScripts={vi.fn()}
                connection={connection} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />
        </SessionConnectionAttentionContext.Provider>));
        const handler = state.keyHandlers.find(value => value.key === 'e' && value.ctrlKey === true);
        act(() => handler.callback({ preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }));
        expect(request).toHaveBeenCalledExactlyOnceWith('session');
        expect(state.executeQuery).not.toHaveBeenCalled();
        const rerun = state.outputProps.statusActions.props.children[1];
        expect(rerun.props.onRerun).toBeUndefined();
        expect(state.deleteCache).not.toHaveBeenCalled();
    });

    it('executes unparseable remote SQL from Ctrl+E without caching', () => {
        const sessionScripts = scripts();
        const sql = 'SELECT * FROM t QUALIFY row_number() OVER (ORDER BY id) = 1';
        sessionScripts.scripts[2].scriptSession = {
            getText: () => sql,
            compileQuery: () => ({
                read: () => ({
                    errorsLength: () => 1,
                    errors: () => ({ message: () => 'syntax error' }),
                    sql: () => sql,
                    cacheSignature: () => '',
                    cacheable: () => false,
                }),
                destroy: () => {},
            }),
            startExecution: () => ({}),
        } as any;
        const connection = { connectionId: 'database', connectionHealth: ConnectionHealth.ONLINE } as any;
        act(() => root.render(<ScriptDetails sessionScripts={sessionScripts} modifySessionScripts={vi.fn()}
            connection={connection} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />));

        const handler = state.keyHandlers.find(value => value.key === 'e' && value.ctrlKey === true);
        expect(handler).toBeDefined();
        act(() => handler.callback({ preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }));
        expect(state.executeQuery).toHaveBeenCalledWith('database', expect.objectContaining({
            query: sql, cacheable: false, cacheSignature: '',
        }));
    });

    it('offers pretty and compact formatting modes', () => {
        const modify = vi.fn();
        act(() => root.render(<ScriptDetails sessionScripts={scripts()} modifySessionScripts={modify}
            connection={null} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />));

        act(() => (container.querySelector('[aria-label="More actions for second script"]') as HTMLButtonElement).click());
        const labels = Array.from(document.querySelectorAll('button')).map(button => button.textContent);
        expect(labels).toContain('Format Pretty');
        expect(labels).toContain('Format Compact');
        expect(labels).toContain('Delete');

        const formatButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Format Pretty') as HTMLButtonElement;
        act(() => formatButton.click());
        expect(state.formatScriptEditor).toHaveBeenCalledWith(expect.anything(), expect.anything(),
            dashql.buffers.formatting.FormattingMode.PRETTY, expect.any(Function), false,
            dashql.buffers.formatting.KeywordCase.LOWER, dashql.buffers.formatting.FormattingDialect.TRINO);
        expect(modify).toHaveBeenCalledWith({
            type: SET_SCRIPT_TEXT,
            value: { scriptKey: 2, text: 'SELECT 2;', withDiff: true },
        });
    });

    it('deletes the script from the more menu and returns to the feed', () => {
        const modify = vi.fn();
        const hideDetails = vi.fn();
        act(() => root.render(<ScriptDetails sessionScripts={scripts()} modifySessionScripts={modify}
            connection={null} hideDetails={hideDetails} scriptId={2} dependencies={dependencies} />));

        act(() => (container.querySelector('[aria-label="More actions for second script"]') as HTMLButtonElement).click());
        const deleteButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Delete') as HTMLButtonElement;
        act(() => deleteButton.click());

        expect(modify).toHaveBeenCalledWith({ type: DELETE_SCRIPT, value: '02_second.sql' });
        expect(hideDetails).toHaveBeenCalledOnce();
    });

    it('exposes one control to shrink back to the feed', () => {
        act(() => root.render(<ScriptDetails sessionScripts={scripts()} modifySessionScripts={vi.fn()}
            connection={null} hideDetails={() => {}} scriptId={2} dependencies={dependencies} />));

        expect(container.querySelectorAll('[aria-label="Shrink script details"]')).toHaveLength(1);
        expect(container.querySelector('[aria-label="Close script details"]')).toBeNull();
    });
});
