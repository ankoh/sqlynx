import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dashql from '@ankoh/dashql-core';
import { ScriptFeedRow, type ScriptFeedRowDependencies } from './session_feed_row.js';
import { ConnectorType } from '../../../connections/connector_info.js';
import { ConnectionHealth } from '../../../connections/connection_state.js';
import { SessionConnectionAttentionContext } from '../session_connection_attention.js';
import { SessionDataCard, type SessionDataCardProps } from './session_data_card.js';
import { HYPER_CONNECTOR, TRINO_CONNECTOR } from '../../../connections/connector_info.js';
import { LoggerProvider } from '../../../../platform/logger/logger_provider.js';
import { WebFileDownloader } from '../../../../platform/file/web_file_downloader.js';
import { SessionTestBackend } from '../../../storage/session_test_backend.js';
import { SessionFeed, type SessionFeedDependencies } from './session_feed.js';
import { SessionComposerVariant, type SessionComposerProps } from './session_composer.js';
import { ComposerInputMode } from '../../ai/input_mode.js';
import { CREATE_SCRIPT, SET_SCRIPT_TEXT, type SessionScripts } from '../../scripts/session_scripts.js';
import { CONNECTOR_INFOS } from '../../../connections/connector_info.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const state = { query: null as any, sortableTransform: null as any, formatScriptEditor: vi.fn() };
const dependencies = {
    useSortable: () => ({
        attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: state.sortableTransform, transition: undefined, isDragging: false,
    }),
    translateTransform: (transform: { x: number; y: number } | null) => transform == null
        ? undefined
        : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    scriptCard: {
        useQueryState: () => state.query,
        useCancelQuery: () => vi.fn(),
        computeQueryCacheKeyForConnection: vi.fn(),
        ScriptEditor: (props: any) => {
            React.useEffect(() => props.setView?.({}), [props.setView]);
            return <div data-testid="editor" />;
        },
        ScriptDiagnosticsButton: () => <button>diagnostics</button>,
        ScriptStatisticsBar: () => null,
        isScriptFormattable: () => true,
        formatScriptEditor: (...args: any[]) => {
            state.formatScriptEditor(...args);
            args[3]('SELECT 1;');
        },
        CachedResultBean: () => null,
        QueryResultCacheLabel: () => null,
        QueryResultRerunButton: () => null,
        EntryStatusBar: (props: any) => <button data-testid="status" onClick={props.onToggleExpanded}>{props.status.message}</button>,
        FeedEntryFooter: () => <div data-testid="integrated-footer">footer</div>,
    },
} as unknown as ScriptFeedRowDependencies;
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

function baseProps() {
    return {
        sessionId: 'session', connections: new Map(), cacheQueryResults: false,
        storageReader: { backend: { hasCachedQueryResult: vi.fn() }, getSessionLocation: () => ({ type: 'opfs' }) },
        entries: [{ scriptId: 1, fileName: '01_alpha.sql' }, { scriptId: 2, fileName: '02_beta.sql' }],
        scripts: { 1: script(1, '01_alpha.sql'), 2: script(2, '02_beta.sql') }, scriptDebugMode: false, formattingDebugMode: false,
        keywordCase: dashql.buffers.formatting.KeywordCase.UPPER,
        focusedFileName: '01_alpha.sql', active: true, onFocus: vi.fn(), onDelete: vi.fn(),
        onRename: vi.fn(), onPickConnection: vi.fn(), onMoveUp: vi.fn(), onMoveDown: vi.fn(), onExecute: vi.fn(), onShowStatus: vi.fn(),
         onShowTable: vi.fn(), onShowVisualization: vi.fn(), onShowDetails: vi.fn(), onRerun: vi.fn(),
        onFormat: vi.fn(), onAcceptDiff: vi.fn(), onRejectDiff: vi.fn(), collapsedResults: new Map(), onToggleResultExpanded: vi.fn(),
        generations: new Map(), onStopGeneration: vi.fn(), onDismissGeneration: vi.fn(),
        onAutoCollapseResult: vi.fn(), onResetAutoCollapsedResult: vi.fn(), topPadding: 16,
        onCreate: vi.fn(), onEditorView: vi.fn(), onRowHeightChange: vi.fn(), dependencies,
    };
}

function script(scriptKey: number, fileName: string) {
    return { scriptKey, fileName, scriptSession: { getText: () => 'SELECT 1' }, analysisOutdated: true,
        annotations: {}, statistics: [], completion: null, pendingDiff: null, latestQueryId: null,
        connection: { connectionId: 'database', connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO], catalog: {} } };
}

describe('V2 session feed rows', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => { state.query = null; state.sortableTransform = null; state.formatScriptEditor.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    it('keeps the HyperDB path behind a copy action and disables every file action for non-WASM connections', () => {
        const sessionId = '12345678-1234-1234-1234-123456789abc';
        const props: SessionDataCardProps = {
            sessionId, file: { name: 'sales 2.csv', sizeBytes: 42 },
            conn: null, storageReader: { backend: new SessionTestBackend() } as any, onRemoved: vi.fn(),
        };
        for (const conn of [null,
            { details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'V3_HTTP' } } } } },
            { details: { type: TRINO_CONNECTOR, value: {} } },
        ]) {
            act(() => root.render(<LoggerProvider>
                <SessionDataCard {...props} conn={conn as any} />
            </LoggerProvider>));
            expect(container.textContent).not.toContain(`/mnt/fs/sessions/${sessionId}/attachments/sales 2.csv`);
            expect(container.textContent).toContain('42 bytes');
            expect(container.querySelector('[aria-hidden="true"]')?.textContent).toContain('CSV');
            const buttons = Array.from(container.querySelectorAll('button'));
            expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
                'Copy HyperDB path for sales 2.csv', 'Download sales 2.csv', 'Remove sales 2.csv',
            ]);
            expect(buttons.every(button => button.disabled)).toBe(true);
            expect(container.querySelector('[aria-label*="reorder"]')).toBeNull();
        }
    });

    it('downloads data bytes and removes the file before requesting a list refresh for HyperDB WASM', async () => {
        const backend = new SessionTestBackend();
        const bytes = new Uint8Array([0, 255, 13]);
        await backend.saveDataFile('session', 'sales.csv', bytes);
        const onRemoved = vi.fn();
        const download = vi.spyOn(WebFileDownloader.prototype, 'downloadBufferAsFile').mockResolvedValue();
        try {
            act(() => root.render(<LoggerProvider>
                <SessionDataCard sessionId="session" file={{ name: 'sales.csv', sizeBytes: 3 }}
                    conn={{ details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } } } as any}
                    storageReader={{ backend } as any} onRemoved={onRemoved} />
            </LoggerProvider>));
            const downloadButton = container.querySelector<HTMLButtonElement>('[aria-label="Download sales.csv"]');
            expect(downloadButton).not.toBeNull();
            expect(Array.from(container.querySelectorAll('button')).every(button => !button.disabled)).toBe(true);
            await act(async () => { downloadButton!.click(); });
            expect(download).toHaveBeenCalledExactlyOnceWith(bytes, 'sales.csv');
            await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove sales.csv"]')!.disabled).toBe(false));
            await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Remove sales.csv"]')!.click(); });
            expect(await backend.listDataFiles('session')).toEqual([]);
            expect(onRemoved).toHaveBeenCalledExactlyOnceWith();
        } finally {
            download.mockRestore();
        }
    });

    it('renders insertion separators before, between, and after flat scripts', () => {
        const props = baseProps();
        act(() => root.render(<>{[0, 2, 4].map(index => <ScriptFeedRow key={index} {...({ ...props, index, style: {} } as any)} />)}</>));
        expect(Array.from(container.querySelectorAll('button')).map(button => button.getAttribute('aria-label'))).toEqual([
            'Add script at position 1', 'Add script at position 2', 'Add script at position 3',
        ]);
        expect((container.firstElementChild as HTMLElement).style.paddingTop).toBe('16px');
        act(() => (container.firstElementChild?.firstElementChild as HTMLElement).click());
        expect(props.onCreate).toHaveBeenCalledWith(0);
        act(() => (container.querySelector('[aria-label="Add script at position 2"]') as HTMLButtonElement).click());
        expect(props.onCreate).toHaveBeenCalledWith(1);
    });

    it('focuses on pointer entry and exposes integrated execution footer', () => {
        const props = baseProps();
        props.scripts[1] = { ...props.scripts[1], latestQueryId: 42 } as any;
        state.query = { queryId: 42, traceId: 9, status: 9, resultTable: {} };
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));
        const article = container.querySelector('article')!;
        act(() => article.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
        expect(props.onFocus).toHaveBeenCalledWith('01_alpha.sql');
        expect(container.querySelector('[data-testid="status"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="integrated-footer"]')).not.toBeNull();
        expect(container.querySelector('[aria-label="Drag 01_alpha script to reorder"]')).not.toBeNull();
        const moreButton = container.querySelector('[aria-label="More actions for 01_alpha script"]') as HTMLButtonElement;
        expect(moreButton).not.toBeNull();
        act(() => moreButton.click());
        const compactButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Format Compact') as HTMLButtonElement;
        expect(compactButton).not.toBeNull();
        act(() => compactButton.click());
        expect(state.formatScriptEditor).toHaveBeenCalledWith(
            expect.anything(),
            props.scripts[1],
            dashql.buffers.formatting.FormattingMode.COMPACT,
            expect.any(Function),
            false,
            dashql.buffers.formatting.KeywordCase.UPPER,
            dashql.buffers.formatting.FormattingDialect.TRINO,
        );
        expect(props.onFormat).toHaveBeenCalledWith(1, 'SELECT 1;');
        props.scripts[1] = { ...props.scripts[1], pendingDiff: {} } as any;
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));
        expect(container.querySelector('[aria-label="Accept rewrite"]')).not.toBeNull();
        expect(container.querySelector('[aria-label="Reject rewrite"]')).not.toBeNull();
        const expandButton = container.querySelector('[aria-label="Expand 01_alpha script details"]') as HTMLButtonElement;
        const moveUpButton = container.querySelector('[aria-label="Move script up"]') as HTMLButtonElement;
        const moveDownButton = container.querySelector('[aria-label="Move script down"]') as HTMLButtonElement;
        expect(moreButton.compareDocumentPosition(moveUpButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(moveUpButton.compareDocumentPosition(moveDownButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(moveDownButton.compareDocumentPosition(expandButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        act(() => expandButton.click());
        expect(props.onShowDetails).toHaveBeenCalledWith('01_alpha.sql');
        expect(container.querySelector('[aria-label="Move script up"]')?.hasAttribute('disabled')).toBe(true);
        expect(container.querySelector('[aria-label="Move script down"]')?.hasAttribute('disabled')).toBe(false);
        const deleteButton = container.querySelector('[aria-label="Delete 01_alpha script"]') as HTMLButtonElement;
        expect(deleteButton.compareDocumentPosition(moreButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        act(() => deleteButton.click());
        expect(props.onDelete).toHaveBeenCalledWith('01_alpha.sql');
    });

    it('shows the connection instead of the file name and edits the file in the storage view', () => {
        const props = baseProps();
        Object.assign(props, { connections: new Map([['database', {
            connectionId: 'database', connectionHealth: ConnectionHealth.ONLINE, details: null, connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO],
            label: 'Trino Http', labelParts: { name: 'Trino', detail: 'Http' },
        }]]) });
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));
        // The connection takes the place of the file name
        const picker = container.querySelector('[aria-label="Connection of 01_alpha script: Trino Http"]')!;
        // The name is the label, the protocol is the trailing tag
        expect(picker.textContent).toBe('TrinoHttp');
        expect(picker.parentElement!.textContent).toBe('TrinoHttp');
        expect(Array.from(picker.querySelectorAll('span')).some(span => span.textContent === 'Http' && span.children.length === 0)).toBe(true);
        // A plain database icon leads the label, the same for every connector
        expect(picker.querySelector('use')?.getAttribute('xlink:href')).toContain('#database_16');

        act(() => (container.querySelector('[aria-label="More actions for 01_alpha script"]') as HTMLButtonElement).click());
        act(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Storage')!.click());
        const storage = document.querySelector('[role="dialog"][aria-label="Storage of 01_alpha script"]')!;
        expect(storage.textContent).toContain('opfs://sessions/session/scripts/01_alpha.sql');
        const input = storage.querySelector<HTMLInputElement>('[aria-label="Script file name"]')!;
        expect(input.value).toBe('01_alpha.sql');
        input.value = 'report';
        act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        act(() => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
        expect(props.onRename).toHaveBeenCalledWith('01_alpha.sql', 'report');
    });

    it('keeps Play available for SQL with parser diagnostics', () => {
        const props = baseProps();
        Object.assign(props, { connections: new Map([['database', {
            connectionId: 'database', connectionHealth: ConnectionHealth.ONLINE, details: null, connectorInfo: CONNECTOR_INFOS[ConnectorType.TRINO], label: 'Trino Http',
            labelParts: { name: 'Trino', detail: 'Http' },
        }]]) });
        props.scripts[1] = { ...props.scripts[1], analysisOutdated: false,
            editorUpdate: { analysisAvailable: true }, scriptSession: { getText: () => 'SELECT * FROM t QUALIFY x = 1' } } as any;
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));

        const play = container.querySelector('[aria-label="Execute 01_alpha query"]') as HTMLButtonElement;
        expect(play.disabled).toBe(false);
        act(() => play.click());
        expect(props.onExecute).toHaveBeenCalledWith('01_alpha.sql');
    });

    it('lets the virtual list observe the row content height', () => {
        const props = baseProps();
        const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 312 } as DOMRect);
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));
        expect((container.firstElementChild as HTMLElement).style.height).toBe('');
        expect(props.onRowHeightChange).toHaveBeenCalledWith(1, 312);
        rect.mockRestore();
    });

    it('blocks execution offline and requests attention once per pointer entry without opening settings', () => {
        const props = baseProps();
        const request = vi.fn();
        act(() => root.render(<SessionConnectionAttentionContext.Provider value={{ sessionId: 'session', active: false, request }}>
            <ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />
        </SessionConnectionAttentionContext.Provider>));
        const play = container.querySelector<HTMLButtonElement>('[aria-label="Execute 01_alpha query"]')!;
        expect(play.disabled).toBe(true);
        act(() => play.click());
        expect(props.onExecute).not.toHaveBeenCalled();
        const wrapper = play.parentElement!;
        act(() => {
            wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: play }));
            wrapper.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        });
        expect(request).toHaveBeenCalledExactlyOnceWith('session');
        expect(wrapper.tabIndex).toBe(0);
        expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('Connect to execute');
    });

    it('offers to stop while the SQL of a question is generated', () => {
        const props = baseProps();
        const controller = new AbortController();
        props.generations = new Map([[1, { controller, error: null }]]) as any;
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));
        expect(container.querySelector('[aria-label="Execute 01_alpha query"]')).toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Stop generating 01_alpha query"]')!.click());
        expect(props.onStopGeneration).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('shows a failed generation until it is dismissed', () => {
        const props = baseProps();
        props.generations = new Map([[1, { controller: new AbortController(), error: 'HTTP 500' }]]) as any;
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));
        expect(container.querySelector('[aria-label="Stop generating 01_alpha query"]')).toBeNull();
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
        expect(container.querySelector('[aria-label="Execute 01_alpha query"]')).not.toBeNull();
        act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss the error"]')!.click());
        expect(props.onDismissGeneration).toHaveBeenCalledExactlyOnceWith(1);
    });

    it('translates a dragged card without applying dnd-kit scale distortion', () => {
        const props = baseProps();
        state.sortableTransform = { x: 0, y: 120, scaleX: 0.8, scaleY: 0.4 };
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));

        const item = container.querySelector('[aria-label="Drag 01_alpha script to reorder"]')!.parentElement as HTMLElement;
        expect(item.style.transform).toBe('translate3d(0px, 120px, 0px)');
        expect(item.style.transform).not.toContain('scale');
    });
});

describe('Session feed composer', () => {
    const feedState = {
        keyHandlers: [] as any[],
        composerProps: null as SessionComposerProps | null,
        runSessionScript: vi.fn(),
        executeQuery: vi.fn(),
        generateSqlFromPrompt: vi.fn(),
        aiClient: null as any,
        submit: vi.fn(),
        view: null as any,
    };
    const feedDependencies: SessionFeedDependencies = {
        useQueryExecutor: () => feedState.executeQuery,
        useStorageReader: () => ({ backend: { listDataFiles: () => Promise.resolve([]) } }) as any,
        useStorageWriter: () => ({ write: () => Promise.resolve({ status: 'written' }) }) as any,
        usePickScriptConnection: () => vi.fn(),
        useKeyEvents: (handlers: any[]) => { feedState.keyHandlers = handlers; },
        runSessionScript: feedState.runSessionScript as any,
        useAIClient: () => feedState.aiClient,
        generateSqlFromPrompt: feedState.generateSqlFromPrompt as any,
        SessionComposer: (props: SessionComposerProps) => {
            feedState.composerProps = props;
            if (props.submitRef) props.submitRef.current = feedState.submit;
            React.useEffect(() => props.setView?.(feedState.view), [props.setView]);
            return <div data-testid="composer" />;
        },
        ScriptFeedRow: () => <div />,
    };
    const onlineConn = {
        connectionId: 'database', connectionHealth: ConnectionHealth.ONLINE,
        connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER],
        details: { type: HYPER_CONNECTOR, value: { proto: {} } },
    } as any;

    function session(fileNames: string[] = []): SessionScripts {
        const scripts: SessionScripts['scripts'] = {};
        const scriptRefs: SessionScripts['scriptRefs'] = {};
        fileNames.forEach((fileName, i) => {
            scripts[i + 1] = script(i + 1, fileName) as any;
            scriptRefs[fileName] = { scriptId: i + 1, fileName };
        });
        return {
            sessionId: 'session', name: null, connectionId: 'database', settings: { cacheQueryResults: false }, instance: {} as any, sessionMetadata: {} as any,
            connectorInfo: CONNECTOR_INFOS[ConnectorType.HYPER], connectionCatalog: {} as any,
            scripts, scriptRefs, scriptOrder: [...fileNames], scriptFocus: { fileName: fileNames[fileNames.length - 1] ?? '' }, semanticUserFocus: null,
        };
    }

    function fakeView(text: string, hasFocus = true) {
        return {
            hasFocus,
            state: { doc: { toString: () => text, length: text.length } },
            dispatch: vi.fn(),
            focus: vi.fn(),
        };
    }

    let container: HTMLDivElement;
    let root: Root;
    let attention: { sessionId: string; active: boolean; request: ReturnType<typeof vi.fn> };
    beforeEach(() => {
        feedState.keyHandlers = [];
        feedState.composerProps = null;
        feedState.runSessionScript.mockReset();
        feedState.generateSqlFromPrompt.mockReset();
        feedState.submit.mockReset();
        feedState.aiClient = null;
        feedState.view = fakeView('');
        attention = { sessionId: 'session', active: false, request: vi.fn() };
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    function render(sessionScripts: SessionScripts, modifySessionScripts: any, conn: any = onlineConn) {
        act(() => root.render(<LoggerProvider>
            <SessionConnectionAttentionContext.Provider value={attention as any}>
                <SessionFeed sessionScripts={sessionScripts} modifySessionScripts={modifySessionScripts}
                    showDetails={vi.fn()} conn={conn} active={true} dependencies={feedDependencies} />
            </SessionConnectionAttentionContext.Provider>
        </LoggerProvider>));
    }

    it('greets an empty session with the hero composer', () => {
        render(session(), vi.fn());
        expect(container.querySelector('h1')?.textContent).toBe('What do you want to know about your data today?');
        expect(feedState.composerProps?.variant).toBe(SessionComposerVariant.Hero);
    });

    it('docks the composer below the scripts of a session', () => {
        render(session(['1_alpha.sql']), vi.fn());
        expect(container.querySelector('h1')).toBeNull();
        expect(feedState.composerProps?.variant).toBe(SessionComposerVariant.Docked);
    });

    it('appends a sent draft as a script and runs it', async () => {
        const next = session(['1_alpha.sql']);
        const modify = vi.fn(() => Promise.resolve(next));
        render(session(), modify);
        await act(async () => feedState.composerProps!.onSend('select 1', ComposerInputMode.Sql));
        expect(modify).toHaveBeenCalledExactlyOnceWith({ type: CREATE_SCRIPT, value: { index: null, text: 'select 1' } });
        await vi.waitFor(() => expect(feedState.runSessionScript).toHaveBeenCalledOnce());
        expect(feedState.runSessionScript).toHaveBeenCalledExactlyOnceWith(
            next, next.scripts[1], feedState.executeQuery, modify, expect.anything());
        expect(attention.request).not.toHaveBeenCalled();
    });

    it('only creates the script without a healthy connection', async () => {
        const modify = vi.fn(() => Promise.resolve(session(['1_alpha.sql'])));
        render(session(), modify, null);
        await act(async () => feedState.composerProps!.onSend('select 1', ComposerInputMode.Sql));
        expect(modify).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(attention.request).toHaveBeenCalledExactlyOnceWith('session'));
        expect(feedState.runSessionScript).not.toHaveBeenCalled();
    });

    it('sends the draft on Ctrl+E only while the composer has focus', async () => {
        feedState.view = fakeView('select 2', false);
        render(session(['1_alpha.sql']), vi.fn());
        const handler = feedState.keyHandlers.find(h => h.key === 'e' && h.ctrlKey && h.capture);
        const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
        handler.callback(event);
        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(feedState.submit).not.toHaveBeenCalled();

        feedState.view.hasFocus = true;
        await act(async () => handler.callback(event));
        expect(event.stopPropagation).toHaveBeenCalledOnce();
        expect(feedState.submit).toHaveBeenCalledOnce();
    });

    it('offers AI only with a configured provider', () => {
        render(session(), vi.fn());
        expect(feedState.composerProps?.aiAvailable).toBe(false);
        feedState.aiClient = {};
        render(session(), vi.fn());
        expect(feedState.composerProps?.aiAvailable).toBe(true);
    });

    // A catalog without tables and a connection without relations, enough to build the AI prompt
    const emptyCatalog = {
        createUncachedSnapshot: () => ({
            read: () => ({
                catalogReader: { schemasLength: () => 0, tablesLength: () => 0, columnsLength: () => 0 },
                readName: () => '',
            }),
            destroy: () => { },
        }),
    };
    const aiConn = { ...onlineConn, catalogRelationScript: { toString: () => '' } };

    it('creates the script with the question as comment and appends the SQL once it is generated', async () => {
        let resolveSql: (sql: string) => void = () => { };
        feedState.generateSqlFromPrompt.mockImplementation(() => new Promise<string>(resolve => { resolveSql = resolve; }));
        feedState.aiClient = {};
        const created = { ...session(['1_alpha.sql']), connectionCatalog: emptyCatalog as any };
        created.scripts[1] = { ...created.scripts[1], scriptSession: { getText: () => '-- how many rows' } } as any;
        const filled = session(['1_alpha.sql']);
        const modify = vi.fn((action: any) => Promise.resolve(action.type === CREATE_SCRIPT ? created : filled));
        render({ ...session(), connectionCatalog: emptyCatalog as any }, modify, aiConn);

        await act(async () => feedState.composerProps!.onSend('how many rows', ComposerInputMode.Ai));
        expect(modify).toHaveBeenCalledExactlyOnceWith({ type: CREATE_SCRIPT, value: { index: null, text: '-- how many rows' } });
        await vi.waitFor(() => expect(feedState.generateSqlFromPrompt).toHaveBeenCalledOnce());
        expect(feedState.generateSqlFromPrompt).toHaveBeenCalledWith(feedState.aiClient, {
            prompt: 'how many rows',
            dialect: 'Tableau Hyper (PostgreSQL-compatible)',
            schema: '',
            mentionedIdentifiers: [],
        }, expect.any(Function), expect.any(AbortSignal));
        expect(feedState.runSessionScript).not.toHaveBeenCalled();

        // The feed has rendered the created script by the time the SQL arrives
        render(created, modify, aiConn);
        await act(async () => resolveSql('select count(*) from t'));
        await vi.waitFor(() => expect(feedState.runSessionScript).toHaveBeenCalledOnce());
        expect(modify).toHaveBeenLastCalledWith({
            type: SET_SCRIPT_TEXT, value: { scriptKey: 1, text: '-- how many rows\nselect count(*) from t' },
        });
        expect(feedState.runSessionScript).toHaveBeenCalledWith(filled, filled.scripts[1], feedState.executeQuery, modify, expect.anything());
    });

    it('keeps the commented script when the generation fails', async () => {
        feedState.generateSqlFromPrompt.mockRejectedValue(new Error('HTTP 500'));
        feedState.aiClient = {};
        const created = { ...session(['1_alpha.sql']), connectionCatalog: emptyCatalog as any };
        const modify = vi.fn(() => Promise.resolve(created));
        render({ ...session(), connectionCatalog: emptyCatalog as any }, modify, aiConn);
        await act(async () => feedState.composerProps!.onSend('anything', ComposerInputMode.Ai));
        await vi.waitFor(() => expect(feedState.generateSqlFromPrompt).toHaveBeenCalledOnce());
        await act(async () => { });
        expect(modify).toHaveBeenCalledOnce();
        expect(feedState.runSessionScript).not.toHaveBeenCalled();
    });
});
