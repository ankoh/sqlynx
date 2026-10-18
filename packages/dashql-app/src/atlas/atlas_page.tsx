import * as React from 'react';

import { useAppConfig } from '../app/config/app_config.js';
import { useDashQLCoreSetup } from '../app/providers/core_provider.js';
import { analyzeTable } from '../compute/computation_logic.js';
import { useComputationRegistry } from '../compute/computation_registry.js';
import { DELETE_COMPUTATION } from '../compute/computation_state.js';
import type { EmbeddedComputeDatabase } from '../platform/database/embedded_database.js';
import { useEmbeddedDatabaseSetup } from '../platform/database/embedded_database_provider.js';
import { getHyperDBWebSupportError } from '../platform/hyperdb/hyperdb_web_support.js';
import { stringifyError } from '../platform/logger/logger.js';
import { useLogger } from '../platform/logger/logger_provider.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { useShellConnection } from '../shell/shell_connection.js';
import { selectPlatformDirectory } from '../shell/shell_files.js';
import * as baseStyles from '../ui/banner/banner_page.module.css';
import { Button, ButtonVariant } from '../ui/foundations/button.js';
import { FileDirectoryIcon, SyncIcon } from '../ui/foundations/symbol_icon.js';
import { ParticleFlowBackground, type BackgroundAnimation, type BackgroundAnimationLoader } from '../ui/particle_flow/particle_flow_background.js';
import { AtlasIndexUnreadable, AtlasSession, type AtlasPhase, type OpenedFolder } from './atlas_session.js';
import { IndexRowsCard, selectedRows, useRowsCollapsed } from './index_rows.js';
import { DEFAULT_MODEL_BASE_URL } from './index/model.js';
import { demoScript } from './demo_data.js';
import { PromptAction, PromptBar, SearchButton } from './prompt_bar.js';
import type { DotHover, PointCloud } from './point_cloud.js';
import type { SearchResults } from './search/search.js';
import * as styles from './atlas.module.css';

const LOG_CTX = 'atlas';


/// three.js is only loaded once the page is up
const loadPointCloud: BackgroundAnimationLoader = async () => (await import('./point_cloud.js')).PointCloud;

type View =
    | { kind: 'setup'; status: string }
    | { kind: 'pick' }
    | { kind: 'busy'; phase: AtlasPhase }
    /// The index files of the folder could not be loaded, the folder is still mounted and can be reindexed
    | { kind: 'unreadable'; name: string; message: string }
    | { kind: 'search' }
    | { kind: 'script'; name: string; text: string };

/// What the tooltip of a dot says
interface DotTooltip {
    name: string;
    snippet: string;
    tables?: string[];
}

interface AtlasPageProps {
    onEngineVersion: (version: string) => void;
}

function formatProgress(bytesLoaded: number, bytesTotal: number): string {
    if (bytesTotal <= 0) return `${Math.round(bytesLoaded / 1e6)} MB`;
    return `${Math.min(100, Math.round((bytesLoaded / bytesTotal) * 100))}%`;
}

function supportError(platformType: PlatformType): string | null {
    if (platformType === PlatformType.WEB) {
        const hyper = getHyperDBWebSupportError();
        if (hyper != null) return hyper;
    }
    if (typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') {
        return 'Atlas needs the File System Access API to read and write a folder. Open it in Chrome, Edge or another Chromium browser.';
    }
    return null;
}

export const AtlasPage: React.FC<AtlasPageProps> = (props: AtlasPageProps) => {
    const logger = useLogger();
    const appConfig = useAppConfig();
    const platformType = usePlatformType();
    const setupEmbeddedDatabase = useEmbeddedDatabaseSetup();
    const setupCore = useDashQLCoreSetup();
    const { setConnected, queryExecutions } = useShellConnection();
    const modelBaseUrlRef = React.useRef(DEFAULT_MODEL_BASE_URL);
    modelBaseUrlRef.current = appConfig?.atlas?.modelBaseUrl ?? DEFAULT_MODEL_BASE_URL;
    const unsupported = React.useMemo(() => supportError(platformType), [platformType]);

    const [computationState, dispatchComputation] = useComputationRegistry();

    const sessionRef = React.useRef<AtlasSession | null>(null);
    /// The database of the session, the rows of the index files are analyzed there as well
    const databaseRef = React.useRef<EmbeddedComputeDatabase | null>(null);
    const [view, setView] = React.useState<View>({ kind: 'setup', status: 'Instantiating hyperdb-wasm' });
    const [error, setError] = React.useState<string | null>(null);
    const [folder, setFolder] = React.useState<OpenedFolder | null>(null);
    const [prompt, setPrompt] = React.useState('');
    /// The prompt is unfolded out of its search button
    const [searchOpen, setSearchOpen] = React.useState(false);
    const [searching, setSearching] = React.useState(false);
    const [results, setResults] = React.useState<SearchResults[] | null>(null);
    /// The warning about an outdated index was closed, until another folder is opened
    const [outdatedDismissed, setOutdatedDismissed] = React.useState(false);
    const [cloud, setCloud] = React.useState<PointCloud | null>(null);
    /// The script of the candidate under the pointer
    const [hovered, setHovered] = React.useState<string | null>(null);
    /// The dot under the pointer, a made up one as long as no folder is open
    const [dotHover, setDotHover] = React.useState<number | null>(null);
    const tooltipRef = React.useRef<HTMLDivElement>(null);
    /// The computation of the rows of the open folder
    const [rowTableId, setRowTableId] = React.useState<number | null>(null);
    const nextRowTableId = React.useRef(1);
    const [rowsCollapsed, toggleRows] = useRowsCollapsed();
    /// The rows table on the bottom edge, the cloud is centered in the space above it
    const [rowsDock, setRowsDock] = React.useState<HTMLDivElement | null>(null);
    const onAnimation = React.useCallback((animation: BackgroundAnimation | null) => setCloud(animation as PointCloud | null), []);

    // The made up dots only show until a folder is open, then the cloud is the embeddings of the index
    React.useEffect(() => {
        if (cloud == null) return;
        if (folder == null) cloud.clearPoints();
        else cloud.setPoints(folder.points.coords);
    }, [cloud, folder]);

    React.useEffect(() => {
        if (cloud == null) return;
        if (rowsDock == null) {
            cloud.setBottomInset(0);
            return;
        }
        // Follows the table while its handle is dragged or it is collapsed
        const observer = new ResizeObserver(() => cloud.setBottomInset(rowsDock.offsetHeight));
        observer.observe(rowsDock);
        return () => observer.disconnect();
    }, [cloud, rowsDock]);

    // The tooltip follows its dot while the cloud turns, which is too often for React
    React.useEffect(() => {
        if (cloud == null) return;
        cloud.setHoverListener((hover: DotHover | null) => {
            setDotHover(hover?.index ?? null);
            const tooltip = tooltipRef.current;
            if (hover == null || tooltip == null) return;
            // Next to the disc of the dot, on the other side when there is no room
            const gap = hover.radius + 12;
            const flipX = hover.x + gap + tooltip.offsetWidth > window.innerWidth;
            const flipY = hover.y + gap + tooltip.offsetHeight > window.innerHeight;
            const x = flipX ? hover.x - gap - tooltip.offsetWidth : hover.x + gap;
            const y = flipY ? hover.y - gap - tooltip.offsetHeight : hover.y + gap;
            tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
            // Hidden until placed, so that it does not flash in the corner
            tooltip.style.opacity = '1';
        });
        return () => cloud.setHoverListener(null);
    }, [cloud]);
    const onPointerMove = React.useCallback((e: React.PointerEvent<HTMLElement>) => {
        // Only the empty page hovers the cloud, cards and the prompt are in front of it
        cloud?.setPointer(e.target === e.currentTarget ? { x: e.clientX, y: e.clientY } : null);
    }, [cloud]);
    const onPointerLeave = React.useCallback(() => cloud?.setPointer(null), [cloud]);

    // The rows of the index file become a data frame with histograms and cross-filters
    React.useEffect(() => {
        const database = databaseRef.current;
        if (folder == null || database == null || folder.rows.numRows === 0) {
            setRowTableId(null);
            return;
        }
        const id = nextRowTableId.current++;
        setRowTableId(id);
        const analyzed = analyzeTable(id, folder.rows, dispatchComputation, database, logger)
            .catch(e => logger.error('Failed to analyze the index rows', { error: stringifyError(e) }, LOG_CTX));
        // The results of a running analysis must not arrive after the computation is gone
        return () => {
            void analyzed.finally(() => dispatchComputation({ type: DELETE_COMPUTATION, value: [id] }));
        };
    }, [folder, dispatchComputation, logger]);
    const rowTable = rowTableId == null ? null : computationState.tableComputations[rowTableId] ?? null;
    // Only the system columns make the rows filterable, before that the table has no histograms
    const shownRowTable = rowTable?.rowNumberColumnName != null ? rowTable : null;

    // The dots of the rows that match the cross-filters and the data search stay, the others fade
    const filterTable = shownRowTable?.filterTable ?? null;
    const searchedRows = shownRowTable?.dataSearch.matchingRows ?? null;
    React.useEffect(() => {
        cloud?.setSelection(folder == null ? null : selectedRows(shownRowTable));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloud, folder, filterTable, searchedRows]);

    /// The dot of every script
    const pointOfScript = React.useMemo(
        () => new Map<string, number>((folder?.points.scripts ?? []).map((name, point) => [name, point])),
        [folder],
    );
    /// The script of the dot under the pointer
    const dotScript = React.useMemo(() => {
        const points = folder?.points;
        if (points == null || dotHover == null || dotHover >= points.scripts.length) return null;
        return points.scripts[dotHover];
    }, [folder, dotHover]);
    React.useEffect(() => {
        if (cloud == null) return;
        // The cloud turns again once the pointer leaves the candidate
        cloud.setRotationPaused(hovered != null);
        const candidates: number[] = [];
        for (const { hits } of results ?? []) {
            for (const hit of hits) {
                const point = pointOfScript.get(hit.scriptName);
                if (point !== undefined) candidates.push(point);
            }
        }
        // A hovered candidate lights up its dot, a hovered dot lights up itself and marks its script
        if (dotScript != null) candidates.push(pointOfScript.get(dotScript)!);
        let emphasized: readonly number[] = [];
        if (hovered != null) emphasized = pointOfScript.has(hovered) ? [pointOfScript.get(hovered)!] : [];
        else if (dotHover != null) emphasized = [dotHover];
        cloud.setHighlight(candidates, emphasized);
    }, [cloud, results, hovered, dotHover, dotScript, pointOfScript]);

    React.useEffect(() => {
        if (unsupported != null) return;
        let cancelled = false;
        const setup = async () => {
            const database = await setupEmbeddedDatabase(LOG_CTX, progress => {
                if (!cancelled) {
                    setView({
                        kind: 'setup',
                        status: `Instantiating hyperdb-wasm: ${formatProgress(progress.bytesLoaded, progress.bytesTotal)}`,
                    });
                }
            });
            void database.getVersion()
                .then(version => { if (!cancelled) props.onEngineVersion(version); })
                .catch(e => logger.warn('Failed to load engine version', { error: stringifyError(e) }, LOG_CTX));
            if (!cancelled) setView({ kind: 'setup', status: 'Instantiating dashql-core' });
            const core = await setupCore(LOG_CTX);
            if (cancelled) return;
            databaseRef.current = database;
            sessionRef.current = new AtlasSession({ database, core, logger, tracker: queryExecutions, modelBaseUrl: () => modelBaseUrlRef.current });
            setConnected(true);
            setView({ kind: 'pick' });
        };
        setup().catch(e => {
            logger.error('Failed to set up atlas', { error: stringifyError(e) }, LOG_CTX);
            if (!cancelled) setError(stringifyError(e));
        });
        return () => {
            cancelled = true;
            const session = sessionRef.current;
            sessionRef.current = null;
            databaseRef.current = null;
            setConnected(false);
            void session?.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unsupported]);

    /// Show the progress of opening or indexing a folder, and the search once the folder is ready. `keepPrompt` holds on
    /// to the text of the prompt, which a reindex does not invalidate.
    const showFolder = React.useCallback(async (
        name: string,
        run: (report: (phase: AtlasPhase) => void) => Promise<OpenedFolder>,
        message: string,
        keepPrompt: boolean,
    ) => {
        setResults(null);
        setHovered(null);
        setFolder(null);
        if (!keepPrompt) setPrompt('');
        setView({ kind: 'busy', phase: { kind: 'mount', message } });
        try {
            const opened = await run(phase => setView({ kind: 'busy', phase }));
            setFolder(opened);
            setOutdatedDismissed(false);
            setView({ kind: 'search' });
        } catch (e) {
            if (e instanceof AtlasIndexUnreadable) {
                setView({ kind: 'unreadable', name: e.folder, message: e.message });
                return;
            }
            logger.error('Failed to open folder', { error: stringifyError(e), name, stack: e instanceof Error ? e.stack : undefined }, LOG_CTX);
            setError(stringifyError(e));
            setView({ kind: 'pick' });
        }
    }, [logger]);

    const selectFolder = React.useCallback(async () => {
        const session = sessionRef.current;
        if (session == null) return;
        setError(null);
        let handle: FileSystemDirectoryHandle;
        try {
            handle = await selectPlatformDirectory('readwrite');
        } catch (e) {
            // Closing the picker is not an error
            if (e instanceof DOMException && e.name === 'AbortError') return;
            setError(stringifyError(e));
            return;
        }
        await showFolder(handle.name, report => session.open(handle, report), `Mounting ${handle.name}`, false);
    }, [showFolder]);

    const reindex = React.useCallback(async () => {
        const session = sessionRef.current;
        const name = folder?.name ?? (view.kind === 'unreadable' ? view.name : null);
        if (session == null || name == null) return;
        setError(null);
        await showFolder(name, report => session.reindex(report), `Indexing ${name}`, true);
    }, [showFolder, folder, view]);

    const submit = React.useCallback(async () => {
        const session = sessionRef.current;
        const text = prompt.trim();
        if (session == null || text.length === 0 || searching) return;
        setSearching(true);
        setError(null);
        setHovered(null);
        try {
            const found = await session.search(text);
            setResults(found);
            // A wave runs through the cloud from the dot of the best hit
            const best = found[0]?.hits[0];
            const point = best == null ? undefined : pointOfScript.get(best.scriptName);
            if (point !== undefined) cloud?.ripple(point);
        } catch (e) {
            logger.error('Search failed', { error: stringifyError(e) }, LOG_CTX);
            setError(stringifyError(e));
        } finally {
            setSearching(false);
        }
    }, [prompt, searching, logger, cloud, pointOfScript]);

    const openScript = React.useCallback(async (name: string) => {
        const session = sessionRef.current;
        if (session == null) return;
        setHovered(null);
        try {
            setView({ kind: 'script', name, text: await session.readScript(name) });
        } catch (e) {
            logger.error('Failed to read script', { error: stringifyError(e), name }, LOG_CTX);
            setError(stringifyError(e));
        }
    }, [logger]);

    let content: React.ReactNode;
    if (unsupported != null) {
        content = (
            <StepPanel title="Not supported">
                <p>{unsupported}</p>
            </StepPanel>
        );
    } else if (view.kind === 'setup') {
        content = (
            <StepPanel title="Atlas">
                <p>{error ?? view.status}</p>
            </StepPanel>
        );
    } else if (view.kind === 'pick') {
        content = (
            <StepPanel
                title="Select a folder"
                action={<Button variant={ButtonVariant.Primary} onClick={selectFolder}>Select folder</Button>}
            >
                <p>
                    Search the <code>.sql</code> files of a folder by their descriptions and filter them by their SQL and
                    their metadata.
                    Everything stays in your browser, the index is written into the folder.
                </p>
                {error != null && <p className={styles.error}>{error}</p>}
            </StepPanel>
        );
    } else if (view.kind === 'unreadable') {
        content = (
            <StepPanel
                title="Reindex the folder?"
                action={(
                    <div className={styles.step_actions}>
                        <Button onClick={selectFolder}>Select another folder</Button>
                        <Button variant={ButtonVariant.Primary} onClick={() => void reindex()}>Reindex</Button>
                    </div>
                )}
            >
                <p>
                    The index file in <code>{view.name}</code> cannot be loaded. It may have been written by an older
                    version of DashQL. Reindexing the folder replaces it.
                </p>
                <p className={styles.error}>{view.message}</p>
            </StepPanel>
        );
    } else if (view.kind === 'busy') {
        content = (
            <StepPanel title={view.phase.kind === 'model' ? 'Loading model' : 'Indexing'}>
                <p>{view.phase.message}</p>
                <ProgressBar fraction={'fraction' in view.phase ? view.phase.fraction : null} />
            </StepPanel>
        );
    } else if (view.kind === 'script') {
        content = (
            <Card
                title={view.name}
                wide
                actions={<Button onClick={() => setView({ kind: 'search' })}>Back to results</Button>}
            >
                <pre className={styles.script}>{view.text}</pre>
            </Card>
        );
    } else {
        content = (
            <div className={styles.workspace}>
                <div className={styles.prompt_area}>
                    {searchOpen ? (
                        <PromptBar
                            value={prompt}
                            onChange={setPrompt}
                            onSubmit={() => void submit()}
                            busy={searching}
                            placeholder={`Search ${folder?.points.scripts.length ?? 0} described scripts in ${folder?.name ?? 'the folder'}`}
                            start={(
                                <>
                                    <PromptAction icon={<FileDirectoryIcon />} onClick={() => void selectFolder()} disabled={searching}>
                                        Select folder
                                    </PromptAction>
                                    <PromptAction icon={<SyncIcon />} onClick={() => void reindex()} disabled={searching || folder == null}>
                                        Reindex
                                    </PromptAction>
                                </>
                            )}
                            end={folder == null ? null : `${folder.scripts} scripts · ${folder.reused ? 'existing index' : 'index written'}`}
                            onClose={() => setSearchOpen(false)}
                        />
                    ) : (
                        <SearchButton onClick={() => setSearchOpen(true)} />
                    )}
                    {searching && <div className={styles.status}>Searching</div>}
                    {error != null && <div className={styles.error_banner}>{error}</div>}
                    {folder != null && folder.points.scripts.length === 0 && (
                        <div className={styles.warning_banner} role="status">
                            <span className={styles.warning_text}>
                                None of the scripts has a <code>@dashql:description</code> block, there is nothing to
                                search. Describe them with <code>dashql-describe</code> and reindex the folder.
                            </span>
                        </div>
                    )}
                    {folder != null && folder.outdated > 0 && !outdatedDismissed && (
                        <div className={styles.warning_banner} role="status">
                            <span className={styles.warning_text}>
                                The index seems outdated, {folder.outdated} {folder.outdated === 1 ? 'script was' : 'scripts were'} added,
                                changed or removed since it was written.
                            </span>
                            <button className={styles.banner_action} onClick={() => void reindex()} disabled={searching}>
                                Reindex
                            </button>
                            <button className={styles.banner_action} onClick={() => setOutdatedDismissed(true)} aria-label="Dismiss">
                                Dismiss
                            </button>
                        </div>
                    )}
                </div>
                <div className={styles.panels}>
                    {results != null && (
                        <aside className={styles.candidates} aria-label="Candidates">
                            <Card title="Best matches">
                                {results.map(({ strategy, hits }) => (
                                    <section key={strategy.id} className={styles.result_section} aria-label={strategy.title}>
                                        <h2 className={styles.result_title}>{strategy.title}</h2>
                                        {hits.length === 0 && <div className={styles.no_hits}>No matches</div>}
                                        {hits.map(hit => (
                                            <button
                                                key={hit.scriptName}
                                                type="button"
                                                className={styles.hit}
                                                onClick={() => void openScript(hit.scriptName)}
                                                onMouseEnter={() => setHovered(hit.scriptName)}
                                                onMouseLeave={() => setHovered(null)}
                                                onFocus={() => setHovered(hit.scriptName)}
                                                onBlur={() => setHovered(null)}
                                            >
                                                <span className={styles.hit_name}>{hit.scriptName}</span>
                                                <span className={styles.hit_score}>{hit.score.toFixed(3)}</span>
                                                <span className={styles.hit_snippet}>{hit.snippet}</span>
                                            </button>
                                        ))}
                                    </section>
                                ))}
                            </Card>
                        </aside>
                    )}
                </div>
                {folder != null && folder.rows.numRows > 0 && (
                    <div ref={setRowsDock} className={styles.rows}>
                        <IndexRowsCard
                            title="Index"
                            table={shownRowTable}
                            dispatchComputation={dispatchComputation}
                            collapsed={rowsCollapsed}
                            onToggle={toggleRows}
                        />
                    </div>
                )}
            </div>
        );
    }

    let layout: React.ReactNode;
    if (view.kind === 'search') {
        layout = content;
    } else if (view.kind === 'script') {
        layout = <div className={styles.foreground}>{content}</div>;
    } else {
        // The cards of the steps before the search sit on top of the page
        layout = (
            <div className={styles.workspace}>
                <div className={styles.step_area}>
                    {content}
                </div>
            </div>
        );
    }

    let dot: DotTooltip | null = null;
    if (dotHover != null) {
        if (folder == null) {
            dot = demoScript(dotHover);
        } else if (dotScript != null) {
            const tables = folder.points.tables[dotHover] ?? [];
            dot = { name: dotScript, snippet: folder.points.details[dotHover] ?? '', tables: tables.length > 0 ? tables : undefined };
        }
    }
    return (
        <main className={styles.page} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
            <ParticleFlowBackground load={loadPointCloud} onAnimation={onAnimation} className={styles.cloud_stage} />
            {layout}
            {dot != null && (
                <div ref={tooltipRef} className={styles.dot_tooltip} role="tooltip">
                    <div className={styles.hit_name}>{dot.name}</div>
                    {dot.snippet !== '' && <div className={styles.dot_snippet}>{dot.snippet}</div>}
                    {dot.tables != null && <div className={styles.dot_tables}>{dot.tables.join(', ')}</div>}
                </div>
            )}
        </main>
    );
};

/// The steps before the search look like the prompt that replaces them
const StepPanel: React.FC<{ title: string; action?: React.ReactNode; children: React.ReactNode }> = props => (
    <section className={styles.step}>
        <div className={styles.step_text}>
            <h1 className={styles.step_title}>{props.title}</h1>
            <div className={styles.step_body}>{props.children}</div>
        </div>
        {props.action}
    </section>
);

const Card: React.FC<{ title: string; wide?: boolean; actions?: React.ReactNode; children: React.ReactNode }> = props => (
    <section className={`${baseStyles.card} ${styles.card} ${props.wide ? styles.card_wide : ''}`}>
        <div className={baseStyles.card_header}>
            <div className={baseStyles.card_header_left_container}>
                <h1 className={`${baseStyles.card_header_left_title} ${styles.card_title}`}>{props.title}</h1>
            </div>
            {props.actions != null && <div className={baseStyles.card_header_right_container}>{props.actions}</div>}
        </div>
        <div className={baseStyles.card_section}>
            <div className={`${baseStyles.section_entries} ${styles.card_body}`}>{props.children}</div>
        </div>
    </section>
);

const ProgressBar: React.FC<{ fraction: number | null }> = ({ fraction }) => (
    <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={fraction ?? undefined}>
        <div
            className={fraction == null ? styles.progress_indeterminate : styles.progress_bar}
            style={fraction == null ? undefined : { width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }}
        />
    </div>
);
