export function fakeScriptEditorModule(React: typeof import('react'), state: {
    editorFocusByScriptKey?: Map<number, () => void>;
}) {
    return {
        ScriptEditor: (props: { scriptKey?: number; setView?: (view: { hasFocus: boolean; focus: () => void }) => void; onFocus?: () => void }) => {
            const focus = React.useMemo(() => {
                const mock = state.editorFocusByScriptKey?.get(props.scriptKey ?? 0) ?? (() => {});
                return () => mock();
            }, [props.scriptKey]);
            React.useEffect(() => {
                const view = { hasFocus: false, focus };
                props.setView?.(view);
            }, [focus, props.scriptKey]);
            return React.createElement('div', {
                'data-testid': 'script-editor',
                'data-script-key': props.scriptKey,
                tabIndex: 0,
                onFocus: props.onFocus,
            }, 'editor');
        },
    };
}

export function fakeScriptPreviewModule(React: typeof import('react'), state?: { previewReady: boolean; previewFormattable?: boolean }) {
    return {
        ScriptPreview: (props: { onReady?: (ready: boolean) => void; onFormattedText?: (text: string) => void; onFormattingStatus?: (formattable: boolean) => void }) => {
            React.useEffect(() => {
                props.onFormattedText?.('formatted preview');
                props.onFormattingStatus?.(state?.previewFormattable ?? true);
                if (state?.previewReady ?? true) props.onReady?.(true);
            }, [props.onFormattedText, props.onFormattingStatus, props.onReady]);
            return React.createElement(
                'div',
                { 'data-testid': 'script-preview' },
                'preview',
                React.createElement('button', { 'data-dashql-story-control': 'true' }, 'SQL'),
            );
        },
    };
}

export function fakeButtonModule(React: typeof import('react')) {
    return {
        ButtonSize: { Small: 0, Medium: 1, Large: 2 },
        ButtonVariant: { Default: 0, Primary: 1, Danger: 2, Invisible: 3, Outline: 4 },
        Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => React.createElement('button', { ...props, ref }, props.children)),
        IconButton: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => React.createElement('button', { ...props, ref }, props.children)),
    };
}

export function fakeStatusIndicatorModule(React: typeof import('react')) {
    return {
        IndicatorStatus: { Succeeded: 'succeeded' },
        StatusIndicator: () => React.createElement('span', { 'data-testid': 'status-indicator' }),
    };
}

export function fakeSymbolIconModule(React: typeof import('react')) {
    const createIcon = (symbol: string) => (props: Record<string, unknown>) => React.createElement('span', {
        ...props,
        'data-symbol': symbol,
        'data-testid': 'symbol-icon',
    });
    const symbols = {
        AlertIcon: 'alert_16',
        BookIcon: 'book_16',
        CheckIcon: 'check_16',
        ChecklistIcon: 'checklist_16',
        ChevronDownIcon: 'chevron_down_16',
        ChevronLeftIcon: 'chevron_left_16',
        ChevronRightIcon: 'chevron_right_16',
        ChevronUpIcon: 'chevron_up_16',
        CircleSlashIcon: 'circle_slash_16',
        CodeIcon: 'code_16',
        ComposeIcon: 'compose_16',
        CopyIcon: 'copy_16',
        DashIcon: 'dash_16',
        DatabaseIcon: 'database_16',
        DownloadIcon: 'download_16',
        EyeIcon: 'eye_16',
        FileBadgeIcon: 'file_badge_16',
        FileDirectoryFillIcon: 'file_directory_fill_16',
        FileDirectoryIcon: 'file_directory_16',
        FileDirectoryOpenFillIcon: 'file_directory_open_fill_16',
        FileIcon: 'file_16',
        GraphIcon: 'graph_16',
        HeartIcon: 'heart_16',
        HistoryIcon: 'history_16',
        KeyIcon: 'key_16',
        LinkIcon: 'link_16',
        ListUnorderedIcon: 'list_unordered_16',
        LockIcon: 'lock_16',
        PaperAirplaneIcon: 'paper_airplane_16',
        PaperclipIcon: 'paperclip_16',
        PersonIcon: 'person_16',
        PlugIcon: 'plug_16',
        PlusIcon: 'plus_16',
        ProjectIcon: 'project_16',
        RowsIcon: 'rows_16',
        SaveIcon: 'save_16',
        SearchIcon: 'search_16',
        ScreenFullIcon: 'screen_full_16',
        SquareFillIcon: 'square_fill_16',
        SyncIcon: 'sync_16',
        TableIcon: 'table_16',
        ThreeBarsIcon: 'three_bars_16',
        TrashIcon: 'trash_16',
        TriangleDownIcon: 'triangle_down_16',
        UnlinkIcon: 'unlink_16',
        XCircleFillIcon: 'x_circle_16',
        XIcon: 'x_16',
        ZoomInIcon: 'zoom_in_16',
        ZoomOutIcon: 'zoom_out_16',
    };
    return {
        SymbolIcon: createIcon,
        ...Object.fromEntries(Object.entries(symbols).map(([name, symbol]) => [name, createIcon(symbol)])),
    };
}

export function fakeSizeObserverModule() {
    return {
        observeSize: () => ({ width: 640, height: 480 }),
    };
}

export function fakeScrollbarModule() {
    return {
        useScrollbarWidth: () => 17,
        useScrollbarHeight: () => 0,
    };
}

export interface KeyEventMockState {
    keyHandlers: Array<{
        key: string;
        ctrlKey?: boolean;
        capture?: boolean;
        callback: (event: KeyboardEvent) => void;
    }>;
}

let activeKeyEventMockState: KeyEventMockState | null = null;

export function setKeyEventMockState(state: KeyEventMockState) {
    activeKeyEventMockState = state;
}

export function fakeKeyEventsModule() {
    return {
        useKeyEvents: (handlers: KeyEventMockState['keyHandlers']) => {
            if (activeKeyEventMockState == null) throw new Error('Key event mock state is not configured');
            const signature = (handler: KeyEventMockState['keyHandlers'][number]) =>
                `${handler.key}/${handler.ctrlKey}/${handler.capture}`;
            const next = activeKeyEventMockState.keyHandlers.filter(existing =>
                !handlers.some(handler => signature(handler) === signature(existing)));
            activeKeyEventMockState.keyHandlers = [...next, ...handlers];
        },
    };
}

export interface QueryExecutorMockState {
    executeQuery: (...args: any[]) => any;
    queryStates?: ReadonlyMap<number, unknown>;
    cancelQuery?: (...args: any[]) => any;
    cacheKey?: string | null;
}

let activeQueryExecutorMockState: QueryExecutorMockState | null = null;

export function setQueryExecutorMockState(state: QueryExecutorMockState) {
    activeQueryExecutorMockState = state;
}

export function fakeQueryExecutorModule() {
    return {
        useQueryState: (_sessionId: string | null, queryId: number | null) => {
            if (queryId == null) return null;
            return activeQueryExecutorMockState?.queryStates?.get(queryId) ?? null;
        },
        useQueryExecutor: () => {
            if (activeQueryExecutorMockState == null) throw new Error('Query executor mock state is not configured');
            return activeQueryExecutorMockState.executeQuery;
        },
        useCancelQuery: () => activeQueryExecutorMockState?.cancelQuery ?? (async () => {}),
        computeQueryCacheKeyForConnection: async (_details: unknown, signature: string) =>
            signature === 'signature:select 1' ? activeQueryExecutorMockState?.cacheKey ?? null : null,
    };
}

export function fakeReactWindowModule(
    React: typeof import('react'),
    scrollToRowMock: (...args: any[]) => any,
) {
    return {
        useListRef: () => React.useRef({ scrollToRow: scrollToRowMock }),
        useListCallbackRef: (_initialValue: unknown) => React.useState({
            element: null,
            scrollToRow: scrollToRowMock,
        }),
        List: (props: {
            rowCount: number;
            rowHeight: number | ((rowIndex: number) => number);
            rowComponent: React.ComponentType<any>;
            rowProps: any;
            style?: React.CSSProperties;
        }) => {
            const children = Array.from({ length: props.rowCount }, (_, index) => React.createElement(
                'div',
                {
                    key: index,
                    'data-row-height': typeof props.rowHeight === 'number' ? props.rowHeight : props.rowHeight(index),
                    'data-row-script-id': index % 2 === 1 && Math.floor(index / 2) < props.rowProps.entries.length
                        ? props.rowProps.entries[Math.floor(index / 2)].scriptId
                        : undefined,
                },
                React.createElement(props.rowComponent, {
                    index,
                    style: { height: typeof props.rowHeight === 'number' ? props.rowHeight : props.rowHeight(index) },
                    ...props.rowProps,
                }),
            ));
            return React.createElement('div', { 'data-testid': 'mock-list', style: props.style }, children);
        },
    };
}

export class ResizeObserverMock {
    static instances: ResizeObserverMock[] = [];
    private callback: ResizeObserverCallback;
    private elements = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        ResizeObserverMock.instances.push(this);
    }

    observe(element: Element) { this.elements.add(element); }
    disconnect() { }
    unobserve(element: Element) { this.elements.delete(element); }

    trigger() {
        this.callback(Array.from(this.elements, target => ({ target }) as ResizeObserverEntry), this as unknown as ResizeObserver);
    }

    static reset() { ResizeObserverMock.instances = []; }

    static triggerAll() { ResizeObserverMock.instances.forEach(instance => instance.trigger()); }
}
