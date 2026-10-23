import * as React from 'react';
import { createRoot } from 'react-dom/client';
import symbols from '@ankoh/dashql-svg-symbols';
import coreWasmUrl from '@ankoh/dashql-core/wasm?url';

import { createPrecompiledTestCore } from './core_pool.js';
import { DASHQL_GIT_COMMIT, DASHQL_VERSION, HYPERDB_WASM_VERSION } from '../globals.js';
import { IconButton, ButtonSize, ButtonVariant } from '../ui/foundations/button.js';
import { IndicatorStatus, StatusIndicator } from '../ui/foundations/status_indicator.js';
import {
    ChevronDownIcon,
    ChevronRightIcon,
    PaperAirplaneIcon,
    SquareFillIcon,
} from '../ui/foundations/symbol_icon.js';
import { TextInput } from '../ui/foundations/text_input.js';
import type { HyperDBClient } from '../platform/hyperdb/hyperdb_wasm.js';
import { createTestHyperDBClient } from './hyperdb_test_client.js';
import {
    BROWSER_TEST_MESSAGE_SOURCE,
    type BrowserTestCase,
    type BrowserTestFileResult,
    type BrowserTestFrameEvent,
    type BrowserTestSummary,
} from './protocol.js';
import { BLOCKED_BROWSER_TEST_FILES, BROWSER_TEST_FILES } from './test_modules.js';
import styles from './dashboard.module.css';
import '../../static/fonts/fonts.css';
import '../styles/colors.css';
import '../styles/globals.css';

declare global {
    var __DASHQL_BROWSER_TESTS__: BrowserTestSummary;
}

const coreBytes = fetch(coreWasmUrl).then(response => response.bytes());
globalThis.DASHQL_PRECOMPILED = coreBytes;

function getHyperDBClient(): Promise<HyperDBClient> {
    globalThis.__DASHQL_TEST_HYPERDB_CLIENT_PROMISE__ ??= (async () => {
        const creation = (globalThis.__DASHQL_TEST_HYPERDB_CLIENT_CREATIONS__ ?? 0) + 1;
        globalThis.__DASHQL_TEST_HYPERDB_CLIENT_CREATIONS__ = creation;
        try {
            return await createTestHyperDBClient();
        } catch (error) {
            const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            const failure = new Error(`Shared HyperDB startup #${creation} failed: ${detail}`);
            if (error instanceof Error && error.stack) failure.stack = `${failure.stack}\nCaused by: ${error.stack}`;
            throw failure;
        }
    })();
    return globalThis.__DASHQL_TEST_HYPERDB_CLIENT_PROMISE__;
}

globalThis.__DASHQL_TEST_HYPERDB_CLIENT__ = getHyperDBClient;
const hyperDBClient = getHyperDBClient();
globalThis.__DASHQL_TEST_DASHBOARD_CORE_INSTANCE__ ??= hyperDBClient.then(() => {
    globalThis.__DASHQL_TEST_CORE_CREATIONS__ = (globalThis.__DASHQL_TEST_CORE_CREATIONS__ ?? 0) + 1;
    return createPrecompiledTestCore(coreBytes);
});
globalThis.__DASHQL_TEST_CORE_FACTORY__ = () => globalThis.__DASHQL_TEST_DASHBOARD_CORE_INSTANCE__!;

if (!globalThis.__DASHQL_TEST_HYPERDB_UNLOAD_INSTALLED__) {
    globalThis.__DASHQL_TEST_HYPERDB_UNLOAD_INSTALLED__ = true;
    window.addEventListener('pagehide', event => {
        if (!event.persisted) void globalThis.__DASHQL_TEST_HYPERDB_CLIENT_PROMISE__?.then(client => client.terminate());
    });
}

interface DashboardState {
    activeFile: string | null;
    files: Map<string, BrowserTestFileResult>;
    filter: string;
    generation: number;
    requestedFiles: string[];
    running: boolean;
    selectedFile: string | null;
}

const initialFiles = new Map(BROWSER_TEST_FILES.map(file => [file, {
    duration: 0,
    error: null,
    file,
    status: 'queued' as const,
    tests: [],
}]));

function summarize(files: Map<string, BrowserTestFileResult>, running: boolean): BrowserTestSummary {
    const values = [...files.values()].filter(file => file.status !== 'queued');
    const tests = values.flatMap(file => file.tests);
    const failedFiles = values.filter(file => file.error != null).length;
    const failedTests = tests.filter(test => test.status === 'failed').length;
    return {
        duration: values.reduce((sum, file) => sum + file.duration, 0),
        failed: failedTests + failedFiles,
        files: values,
        passed: tests.filter(test => test.status === 'passed').length,
        skipped: tests.filter(test => test.status === 'skipped').length,
        status: running ? 'running' : failedFiles + failedTests > 0 ? 'failed' : 'passed',
        total: tests.length,
    };
}

function TestDashboard(): React.ReactElement {
    const [detailsExpanded, setDetailsExpanded] = React.useState(false);
    const [state, setState] = React.useState<DashboardState>({
        activeFile: null,
        files: initialFiles,
        filter: '',
        generation: 0,
        requestedFiles: [],
        running: false,
        selectedFile: null,
    });
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const summary = summarize(state.files, state.running);
    globalThis.__DASHQL_BROWSER_TESTS__ = summary;

    const handleEvent = React.useEffectEvent((event: BrowserTestFrameEvent) => {
        if (event.type === 'run-end') {
            setState(current => ({ ...current, activeFile: null, running: false }));
            return;
        }
        if (event.type === 'file-start') {
            setState(current => ({
                ...updateFile(current, event.file, file => ({ ...file, status: 'running' })),
                activeFile: event.file,
                selectedFile: event.file,
            }));
            return;
        }
        setState(current => updateFile(current, event.result.file, () => event.result));
    });

    React.useEffect(() => {
        const onMessage = (message: MessageEvent) => {
            if (message.origin !== location.origin || message.source !== frameRef.current?.contentWindow) return;
            if (message.data?.source !== BROWSER_TEST_MESSAGE_SOURCE) return;
            handleEvent(message.data.event as BrowserTestFrameEvent);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, []);

    React.useEffect(() => {
        const params = new URLSearchParams(location.search);
        if (!params.has('autorun')) return;
        const requestedFile = params.get('file');
        runFiles(requestedFile && BROWSER_TEST_FILES.includes(requestedFile) ? [requestedFile] : BROWSER_TEST_FILES);
    }, []);

    React.useEffect(() => {
        if (!state.running) return;
        const timeout = window.setTimeout(() => {
            setState(current => {
                const files = new Map(current.files);
                for (const file of current.requestedFiles) {
                    const result = files.get(file);
                    if (!result || result.status === 'passed' || result.status === 'failed') continue;
                    files.set(file, {
                        ...result,
                        duration: 600_000,
                        error: {
                            message: 'Browser test run did not finish within 10 minutes',
                            name: 'TimeoutError',
                            stack: null,
                        },
                        status: 'failed',
                    });
                }
                return { ...current, activeFile: null, files, running: false };
            });
        }, 600_000);
        return () => window.clearTimeout(timeout);
    }, [state.running, state.generation]);

    function runFiles(files: string[]): void {
        setState(current => {
            const next = new Map(current.files);
            for (const file of files) next.set(file, { duration: 0, error: null, file, status: 'queued', tests: [] });
            return {
                ...current,
                activeFile: null,
                files: next,
                generation: current.generation + 1,
                requestedFiles: files,
                running: true,
                selectedFile: files.length === 1 ? files[0] : current.selectedFile,
            };
        });
    }

    function stop(): void {
        setState(current => ({ ...current, activeFile: null, generation: current.generation + 1, running: false }));
    }

    const visibleFiles = [...state.files.values()].filter(file => {
        const needle = state.filter.trim().toLowerCase();
        return !needle || file.file.toLowerCase().includes(needle)
            || file.tests.some(test => test.titlePath.join(' ').toLowerCase().includes(needle));
    });
    const completedFiles = [...state.files.values()].filter(file => file.status === 'passed' || file.status === 'failed').length;
    const selected = state.selectedFile ? state.files.get(state.selectedFile) ?? null : null;

    return <main className={styles.page}>
        <header className={styles.header}>
            <div className={styles.identity}>
                <svg className={styles.logo} width="28" height="28" aria-hidden="true">
                    <use xlinkHref={`${symbols}#dashql`} />
                </svg>
                <div className={styles.product}>Tests</div>
                <div className={styles.badges}>
                    <span
                        aria-label={`Git commit ${DASHQL_GIT_COMMIT}`}
                        className={styles.metadata_badge}
                        title={`Git commit ${DASHQL_GIT_COMMIT}`}
                    >
                        {DASHQL_GIT_COMMIT.slice(0, 8)}
                    </span>
                    <span
                        aria-label={`DashQL version ${DASHQL_VERSION}`}
                        className={styles.metadata_badge}
                        title={`DashQL version ${DASHQL_VERSION}`}
                    >
                        v{DASHQL_VERSION}
                    </span>
                    <span
                        aria-label={`HyperDB WASM version ${HYPERDB_WASM_VERSION}`}
                        className={styles.metadata_badge}
                        title={`HyperDB WASM version ${HYPERDB_WASM_VERSION}`}
                    >
                        HyperDB {HYPERDB_WASM_VERSION}
                    </span>
                    {BLOCKED_BROWSER_TEST_FILES.length > 0 && <span className={styles.badge}>{BLOCKED_BROWSER_TEST_FILES.length} blocked</span>}
                </div>
            </div>
            <div className={styles.summary} aria-live="polite">
                <StatusGlyph status={state.running ? 'running' : summary.failed > 0 ? 'failed' : completedFiles > 0 ? 'passed' : 'queued'} />
                <Metric label="files" value={`${completedFiles}/${state.files.size}`} />
                <Metric label="passed" value={summary.passed} />
                <Metric label="failed" value={summary.failed} />
                <Metric label="skipped" value={summary.skipped} />
                <Metric label="seconds" value={(summary.duration / 1000).toFixed(1)} />
            </div>
        </header>
        <div className={styles.layout}>
            <aside className={`${styles.details} ${detailsExpanded ? styles.details_expanded : styles.details_collapsed}`}>
                <div className={styles.panel_header}>
                    <button
                        aria-controls="browser-test-details"
                        aria-expanded={detailsExpanded}
                        className={styles.details_toggle}
                        onClick={() => setDetailsExpanded(expanded => !expanded)}
                        type="button"
                    >
                        {detailsExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
                        <span>Details</span>
                    </button>
                </div>
                <div className={styles.panel_body} id="browser-test-details">
                    {selected ? <FileDetails file={selected} />
                        : <div className={styles.empty}>Select a test file to inspect its results.</div>}
                    <iframe
                        className={`${styles.frame} ${state.running ? '' : styles.frame_idle}`}
                        ref={frameRef}
                        src={state.running ? testFrameUrl(state.requestedFiles, state.generation) : 'about:blank'}
                        title="Browser test frame"
                    />
                </div>
                <div className={styles.panel_bottom_inset} aria-hidden="true" />
            </aside>
            <section className={styles.tree} aria-label="Test results">
                <div className={styles.panel_header}>
                    <div className={styles.panel_title}>
                        <span>Test files</span>
                        <span className={styles.panel_count}>{visibleFiles.length}</span>
                    </div>
                    <div className={styles.panel_actions}>
                        <TextInput
                            aria-label="Filter tests"
                            className={styles.filter}
                            onChange={event => setState(current => ({ ...current, filter: event.target.value }))}
                            placeholder="Filter files and tests"
                            type="search"
                            value={state.filter}
                        />
                        <IconButton
                            aria-label={state.running ? 'Stop tests' : 'Run all tests'}
                            className={styles.run_button}
                            onClick={state.running ? stop : () => runFiles(BROWSER_TEST_FILES)}
                            size={ButtonSize.Small}
                            variant={ButtonVariant.Default}
                        >
                            {state.running ? <SquareFillIcon size={14} /> : <PaperAirplaneIcon size={16} />}
                        </IconButton>
                    </div>
                </div>
                <div className={styles.panel_body}>
                    {visibleFiles.length === 0 && <div className={styles.empty}>No matching tests.</div>}
                    {visibleFiles.map(file => <TestFile
                        key={file.file}
                        disabled={state.running}
                        file={file}
                        onRun={() => runFiles([file.file])}
                        onSelect={() => setState(current => ({ ...current, selectedFile: file.file }))}
                    />)}
                </div>
                <div className={styles.panel_bottom_inset} aria-hidden="true" />
            </section>
        </div>
    </main>;
}

function testFrameUrl(files: string[], generation: number): string {
    const params = new URLSearchParams();
    params.set('run', String(generation));
    if (files.length !== BROWSER_TEST_FILES.length) {
        files.forEach(file => params.append('file', file));
    }
    const query = params.toString();
    return `/tests-frame.html${query ? `?${query}` : ''}`;
}

function updateFile(state: DashboardState, file: string, update: (file: BrowserTestFileResult) => BrowserTestFileResult): DashboardState {
    const current = state.files.get(file);
    if (!current) return state;
    const files = new Map(state.files);
    files.set(file, update(current));
    return { ...state, files };
}

function Metric(props: { label: string; value: number | string }): React.ReactElement {
    return <div className={styles.metric}><strong>{props.value}</strong><span>{props.label}</span></div>;
}

function TestFile(props: {
    disabled: boolean;
    file: BrowserTestFileResult;
    onRun: () => void;
    onSelect: () => void;
}): React.ReactElement {
    const [expanded, setExpanded] = React.useState(false);
    const failed = props.file.tests.filter(test => test.status === 'failed').length;
    const hasContent = props.file.error != null || props.file.tests.length > 0;
    return <article className={styles.file}>
        <div className={styles.file_header}>
            <button
                aria-expanded={hasContent ? expanded : undefined}
                className={styles.file_select}
                onClick={() => {
                    props.onSelect();
                    if (hasContent) setExpanded(value => !value);
                }}
                type="button"
            >
                <span
                    className={`${styles.file_chevron} ${hasContent ? '' : styles.file_chevron_disabled}`}
                    aria-hidden="true"
                >
                    {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                </span>
                <StatusGlyph status={props.file.status} />
                <span className={styles.file_name}>{props.file.file}</span>
            </button>
            <span className={styles.count}>{failed ? `${failed} failed` : `${props.file.tests.length} tests`}</span>
            <span className={styles.duration}>{formatDuration(props.file.duration)}</span>
            <IconButton
                aria-label={`Run ${props.file.file}`}
                className={styles.file_run_button}
                disabled={props.disabled}
                onClick={props.onRun}
                size={ButtonSize.Small}
                variant={ButtonVariant.Invisible}
            >
                <PaperAirplaneIcon size={14} />
            </IconButton>
        </div>
        {expanded && hasContent && <ul className={styles.test_list}>
            {props.file.error && <li className={styles.test}><StatusGlyph status="failed" /><span>{props.file.error.message}</span></li>}
            {props.file.tests.map(test => <li className={styles.test} key={test.id}>
                <StatusGlyph status={test.status} />
                <span className={styles.test_title}>
                    <span className={styles.suite_path}>{test.titlePath.slice(0, -1).join(' / ')}{test.titlePath.length > 1 ? ' / ' : ''}</span>
                    {test.title}
                </span>
                <span className={styles.duration}>{formatDuration(test.duration ?? 0)}</span>
            </li>)}
        </ul>}
    </article>;
}

function FileDetails(props: { file: BrowserTestFileResult }): React.ReactElement {
    const failedTest = props.file.tests.find(test => test.error) ?? null;
    const failure = props.file.error ?? failedTest?.error ?? null;
    return <div className={styles.details_body}>
        <div className={styles.details_title}>
            <StatusGlyph status={props.file.status} />
            <h2>{props.file.file}</h2>
        </div>
        <div className={styles.meta}>{props.file.tests.length} tests · {formatDuration(props.file.duration)}</div>
        {failure && <div className={styles.error}>
            {failedTest && <div className={styles.error_test}>{failedTest.titlePath.join(' / ')}</div>}
            <div className={styles.error_message}>{failure.name}: {failure.message || 'No error message was provided'}</div>
            {failure.stack && <pre className={styles.error_stack}>{failure.stack}</pre>}
        </div>}
    </div>;
}

function StatusGlyph(props: { status: BrowserTestCase['status'] }): React.ReactElement {
    const status = props.status === 'running' ? IndicatorStatus.Running
        : props.status === 'passed' ? IndicatorStatus.Succeeded
            : props.status === 'failed' ? IndicatorStatus.Failed
                : props.status === 'skipped' ? IndicatorStatus.Skip
                    : IndicatorStatus.None;
    return <span className={styles.status} title={props.status}>
        <span aria-hidden="true"><StatusIndicator height="16px" status={status} width="16px" /></span>
        <span className={styles.visually_hidden}>{props.status}</span>
    </span>;
}

function formatDuration(duration: number): string {
    if (duration < 1000) return `${Math.round(duration)}ms`;
    return `${(duration / 1000).toFixed(1)}s`;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing browser test dashboard root');
createRoot(root).render(<TestDashboard />);
