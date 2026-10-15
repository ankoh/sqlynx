import * as React from 'react';
import { act } from '@dashql/browser-test-act';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dashql from '@ankoh/dashql-core';
import { ScriptFeedRow, type ScriptFeedRowDependencies } from './notebook_feed_row.js';
import { ConnectorType } from '../../connections/connector_info.js';
import { ConnectionHealth } from '../../connections/attached_database_state.js';
import { NotebookConnectionAttentionContext } from '../notebook_connection_attention.js';
import { NotebookDataCard, type NotebookDataCardProps } from './notebook_data_card.js';
import { HYPER_CONNECTOR, TRINO_CONNECTOR } from '../../connections/connector_info.js';
import { LoggerProvider } from '../../../../platform/logger/logger_provider.js';
import { FileDownloaderProvider } from '../../../../platform/file/file_downloader_provider.js';
import { WebFileDownloader } from '../../../../platform/file/web_file_downloader.js';
import { NotebookTestBackend } from '../../persistence/notebook_test_backend.js';

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
        notebookId: 'notebook', connection: null, connectorType: ConnectorType.TRINO,
        storageReader: { backend: { hasCachedQueryResult: vi.fn() } },
        entries: [{ scriptId: 1, fileName: '01_alpha.sql' }, { scriptId: 2, fileName: '02_beta.sql' }],
        scripts: { 1: script(1, '01_alpha.sql'), 2: script(2, '02_beta.sql') }, scriptDebugMode: false, formattingDebugMode: false,
        keywordCase: dashql.buffers.formatting.KeywordCase.UPPER,
        focusedFileName: '01_alpha.sql', canDelete: true, active: true, onFocus: vi.fn(), onDelete: vi.fn(),
        onRename: vi.fn(), onMoveUp: vi.fn(), onMoveDown: vi.fn(), onExecute: vi.fn(), onShowStatus: vi.fn(),
         onShowTable: vi.fn(), onShowVisualization: vi.fn(), onShowDetails: vi.fn(), onRerun: vi.fn(),
        onFormat: vi.fn(), onAcceptDiff: vi.fn(), onRejectDiff: vi.fn(), collapsedResults: new Map(), onToggleResultExpanded: vi.fn(),
        onAutoCollapseResult: vi.fn(), onResetAutoCollapsedResult: vi.fn(), topPadding: 16,
        onCreate: vi.fn(), onEditorView: vi.fn(), onRowHeightChange: vi.fn(), dependencies,
    };
}

function script(scriptKey: number, fileName: string) {
    return { scriptKey, fileName, scriptSession: { getText: () => 'SELECT 1' }, analysisOutdated: true,
        annotations: {}, statistics: [], completion: null, pendingDiff: null, latestQueryId: null };
}

describe('V2 notebook feed rows', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => { state.query = null; state.sortableTransform = null; state.formatScriptEditor.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
    afterEach(() => { act(() => root.unmount()); container.remove(); });

    it('keeps the HyperDB path behind a copy action and disables every file action for non-WASM connections', () => {
        const notebookId = '12345678-1234-1234-1234-123456789abc';
        const props: NotebookDataCardProps = {
            notebookId, file: { name: 'sales 2.csv', sizeBytes: 42 },
            conn: null, storageReader: { backend: new NotebookTestBackend() } as any, onRemoved: vi.fn(),
        };
        for (const conn of [null,
            { details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'V3_HTTP' } } } } },
            { details: { type: TRINO_CONNECTOR, value: {} } },
        ]) {
            act(() => root.render(<LoggerProvider><FileDownloaderProvider>
                <NotebookDataCard {...props} conn={conn as any} />
            </FileDownloaderProvider></LoggerProvider>));
            expect(container.textContent).not.toContain(`/mnt/fs/notebooks/${notebookId}/attachments/sales 2.csv`);
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
        const backend = new NotebookTestBackend();
        const bytes = new Uint8Array([0, 255, 13]);
        await backend.saveDataFile('notebook', 'sales.csv', bytes);
        const onRemoved = vi.fn();
        const download = vi.spyOn(WebFileDownloader.prototype, 'downloadBufferAsFile').mockResolvedValue();
        try {
            act(() => root.render(<LoggerProvider><FileDownloaderProvider>
                <NotebookDataCard notebookId="notebook" file={{ name: 'sales.csv', sizeBytes: 3 }}
                    conn={{ details: { type: HYPER_CONNECTOR, value: { proto: { setupParams: { protocol: 'WASM' } } } } } as any}
                    storageReader={{ backend } as any} onRemoved={onRemoved} />
            </FileDownloaderProvider></LoggerProvider>));
            const downloadButton = container.querySelector<HTMLButtonElement>('[aria-label="Download sales.csv"]');
            expect(downloadButton).not.toBeNull();
            expect(Array.from(container.querySelectorAll('button')).every(button => !button.disabled)).toBe(true);
            await act(async () => { downloadButton!.click(); });
            expect(download).toHaveBeenCalledExactlyOnceWith(bytes, 'sales.csv');
            await vi.waitFor(() => expect(container.querySelector<HTMLButtonElement>('[aria-label="Remove sales.csv"]')!.disabled).toBe(false));
            await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Remove sales.csv"]')!.click(); });
            expect(await backend.listDataFiles('notebook')).toEqual([]);
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
        expect(container.querySelector('[aria-label="Drag alpha script to reorder"]')).not.toBeNull();
        const moreButton = container.querySelector('[aria-label="More actions for alpha script"]') as HTMLButtonElement;
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
        const expandButton = container.querySelector('[aria-label="Expand alpha script details"]') as HTMLButtonElement;
        const moveUpButton = container.querySelector('[aria-label="Move script up"]') as HTMLButtonElement;
        const moveDownButton = container.querySelector('[aria-label="Move script down"]') as HTMLButtonElement;
        expect(moreButton.compareDocumentPosition(moveUpButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(moveUpButton.compareDocumentPosition(moveDownButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        expect(moveDownButton.compareDocumentPosition(expandButton) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        act(() => expandButton.click());
        expect(props.onShowDetails).toHaveBeenCalledWith('01_alpha.sql');
        expect(container.querySelector('[aria-label="Move script up"]')?.hasAttribute('disabled')).toBe(true);
        expect(container.querySelector('[aria-label="Move script down"]')?.hasAttribute('disabled')).toBe(false);
    });

    it('keeps Play available for SQL with parser diagnostics', () => {
        const props = baseProps();
        props.connection = { databaseId: 'database', connectionHealth: ConnectionHealth.ONLINE } as any;
        props.scripts[1] = { ...props.scripts[1], analysisOutdated: false,
            editorUpdate: { analysisAvailable: true }, scriptSession: { getText: () => 'SELECT * FROM t QUALIFY x = 1' } } as any;
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));

        const play = container.querySelector('[aria-label="Execute alpha query"]') as HTMLButtonElement;
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
        act(() => root.render(<NotebookConnectionAttentionContext.Provider value={{ notebookId: 'notebook', active: false, request }}>
            <ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />
        </NotebookConnectionAttentionContext.Provider>));
        const play = container.querySelector<HTMLButtonElement>('[aria-label="Execute alpha query"]')!;
        expect(play.disabled).toBe(true);
        act(() => play.click());
        expect(props.onExecute).not.toHaveBeenCalled();
        const wrapper = play.parentElement!;
        act(() => {
            wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
            wrapper.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: play }));
            wrapper.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
        });
        expect(request).toHaveBeenCalledExactlyOnceWith('notebook');
        expect(wrapper.tabIndex).toBe(0);
        expect(container.querySelector('[role="tooltip"]')?.textContent).toContain('Connect to execute');
    });

    it('translates a dragged card without applying dnd-kit scale distortion', () => {
        const props = baseProps();
        state.sortableTransform = { x: 0, y: 120, scaleX: 0.8, scaleY: 0.4 };
        act(() => root.render(<ScriptFeedRow {...({ ...props, index: 1, style: {} } as any)} />));

        const item = container.querySelector('[aria-label="Drag alpha script to reorder"]')!.parentElement as HTMLElement;
        expect(item.style.transform).toBe('translate3d(0px, 120px, 0px)');
        expect(item.style.transform).not.toContain('scale');
    });
});
