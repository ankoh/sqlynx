import * as React from 'react';

import { useAIClientForTask } from '../app/config/ai_models_provider.js';
import { useAppConfig } from '../app/config/app_config.js';
import { useDashQLCoreSetup } from '../app/providers/core_provider.js';
import { analyzeTable } from '../compute/computation_logic.js';
import { useComputationRegistry } from '../compute/computation_registry.js';
import { DELETE_COMPUTATION } from '../compute/computation_state.js';
import { AITask } from '../platform/ai/ai_models.js';
import type { EmbeddedComputeDatabase } from '../platform/database/embedded_database.js';
import { useEmbeddedDatabaseSetup } from '../platform/database/embedded_database_provider.js';
import { getHyperDBWebSupportError } from '../platform/hyperdb/hyperdb_web_support.js';
import { stringifyError } from '../platform/logger/logger.js';
import { useLogger } from '../platform/logger/logger_provider.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { useShellConnection } from '../shell/shell_connection.js';
import { selectPlatformDirectory } from '../shell/shell_files.js';
import { ParticleFlowBackground, type BackgroundAnimation, type BackgroundAnimationLoader } from '../ui/particle_flow/particle_flow_background.js';
import { AtlasSession, type AtlasPhase, type DescribeSummary, type OpenedFolder } from './atlas_session.js';
import { DescribeCard, FolderCard, IndexCard, SearchCard, type AtlasActivity } from './atlas_steps.js';
import type { DescribeOutcome } from './describe/describe.js';
import { IndexRowsCard, selectedRows, useRowsCollapsed } from './index_rows.js';
import { DEFAULT_MODEL_BASE_URL } from './index/model.js';
import { demoScript } from './demo_data.js';
import type { DotHover, PointCloud } from './point_cloud.js';
import type { SearchResults } from './search/search.js';
import * as styles from './atlas.module.css';

const LOG_CTX = 'atlas';


/// three.js is only loaded once the page is up
const loadPointCloud: BackgroundAnimationLoader = async () => (await import('./point_cloud.js')).PointCloud;

type View =
    | { kind: 'setup'; status: string }
    | { kind: 'ready' };

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
    const describeClient = useAIClientForTask(AITask.Describe);
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
    const index = folder?.index ?? null;
    /// Opening, indexing or describing the folder, one at a time
    const [activity, setActivity] = React.useState<AtlasActivity | null>(null);
    const [describeSummary, setDescribeSummary] = React.useState<DescribeSummary | null>(null);
    const describeAbort = React.useRef<AbortController | null>(null);
    const [prompt, setPrompt] = React.useState('');
    const [searching, setSearching] = React.useState(false);
    const [results, setResults] = React.useState<SearchResults[] | null>(null);
    /// The script that was opened from a hit or a dot
    const [openedScript, setOpenedScript] = React.useState<{ name: string; text: string } | null>(null);
    const [cloud, setCloud] = React.useState<PointCloud | null>(null);
    /// The script of the candidate under the pointer
    const [hovered, setHovered] = React.useState<string | null>(null);
    /// The dot under the pointer, a made up one as long as no folder is indexed
    const [dotHover, setDotHover] = React.useState<number | null>(null);
    const tooltipRef = React.useRef<HTMLDivElement>(null);
    /// The computation of the rows of the open folder
    const [rowTableId, setRowTableId] = React.useState<number | null>(null);
    const nextRowTableId = React.useRef(1);
    const [rowsCollapsed, toggleRows] = useRowsCollapsed();
    /// The rows table on the bottom edge, the cloud is centered in the space above it
    const [rowsDock, setRowsDock] = React.useState<HTMLDivElement | null>(null);
    const onAnimation = React.useCallback((animation: BackgroundAnimation | null) => setCloud(animation as PointCloud | null), []);

    // The made up dots only show until a folder is indexed, then the cloud is the embeddings of the index
    React.useEffect(() => {
        if (cloud == null) return;
        if (index == null) cloud.clearPoints();
        else cloud.setPoints(index.points.coords);
    }, [cloud, index]);

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
        if (index == null || database == null || index.rows.numRows === 0) {
            setRowTableId(null);
            return;
        }
        const id = nextRowTableId.current++;
        setRowTableId(id);
        const analyzed = analyzeTable(id, index.rows, dispatchComputation, database, logger)
            .catch(e => logger.error('Failed to analyze the index rows', { error: stringifyError(e) }, LOG_CTX));
        // The results of a running analysis must not arrive after the computation is gone
        return () => {
            void analyzed.finally(() => dispatchComputation({ type: DELETE_COMPUTATION, value: [id] }));
        };
    }, [index, dispatchComputation, logger]);
    const rowTable = rowTableId == null ? null : computationState.tableComputations[rowTableId] ?? null;
    // Only the system columns make the rows filterable, before that the table has no histograms
    const shownRowTable = rowTable?.rowNumberColumnName != null ? rowTable : null;

    // The dots of the rows that match the cross-filters and the data search stay, the others fade
    const filterTable = shownRowTable?.filterTable ?? null;
    const searchedRows = shownRowTable?.dataSearch.matchingRows ?? null;
    React.useEffect(() => {
        cloud?.setSelection(index == null ? null : selectedRows(shownRowTable));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cloud, index, filterTable, searchedRows]);

    /// The dot of every script
    const pointOfScript = React.useMemo(
        () => new Map<string, number>((index?.points.scripts ?? []).map((name, point) => [name, point])),
        [index],
    );
    /// The script of the dot under the pointer
    const dotScript = React.useMemo(() => {
        const points = index?.points;
        if (points == null || dotHover == null || dotHover >= points.scripts.length) return null;
        return points.scripts[dotHover];
    }, [index, dotHover]);
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
            setView({ kind: 'ready' });
        };
        setup().catch(e => {
            logger.error('Failed to set up atlas', { error: stringifyError(e) }, LOG_CTX);
            if (!cancelled) setError(stringifyError(e));
        });
        return () => {
            cancelled = true;
            describeAbort.current?.abort();
            const session = sessionRef.current;
            sessionRef.current = null;
            databaseRef.current = null;
            setConnected(false);
            void session?.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unsupported]);

    /// Run a step of the folder and show its progress on its card. Resolves with null if the step failed.
    const runStep = React.useCallback(async <T,>(
        step: AtlasActivity['step'],
        first: AtlasPhase,
        run: (report: (phase: AtlasPhase) => void) => Promise<T>,
    ): Promise<T | null> => {
        setError(null);
        setActivity({ step, phase: first });
        try {
            return await run(phase => setActivity({ step, phase }));
        } catch (e) {
            logger.error(`Failed to ${step} the folder`, { error: stringifyError(e), stack: e instanceof Error ? e.stack : undefined }, LOG_CTX);
            setError(stringifyError(e));
            return null;
        } finally {
            setActivity(null);
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
        setFolder(null);
        setResults(null);
        setOpenedScript(null);
        setHovered(null);
        setPrompt('');
        setDescribeSummary(null);
        setView({ kind: 'ready' });
        const opened = await runStep('open', { kind: 'mount', message: `Mounting ${handle.name}` }, report => session.open(handle, report));
        setFolder(opened);
    }, [runStep]);

    const indexFolder = React.useCallback(async () => {
        const session = sessionRef.current;
        if (session == null) return;
        const indexed = await runStep('index', { kind: 'scan', message: 'Looking for .sql files' }, report => session.index(report));
        if (indexed == null) return;
        // The hits may point to scripts that are gone, the prompt stays
        setResults(null);
        setHovered(null);
        setFolder(indexed);
    }, [runStep]);

    const describeFolder = React.useCallback(async () => {
        const session = sessionRef.current;
        if (session == null || describeClient == null) return;
        const abort = new AbortController();
        describeAbort.current = abort;
        setDescribeSummary(null);
        // Every described script is already written into its file, the cards count it right away
        const onScript = (outcome: DescribeOutcome) => {
            if (outcome.status !== 'described') return;
            setFolder(f => f == null ? f : {
                ...f,
                described: f.described + 1,
                undescribed: Math.max(0, f.undescribed - 1),
                // A loaded index does not know the new description yet
                index: f.index == null ? null : { ...f.index, outdated: f.index.outdated + 1 },
            });
        };
        const summary = await runStep(
            'describe',
            { kind: 'describe', message: 'Describing', fraction: 0 },
            report => session.describe(describeClient, report, abort.signal, onScript),
        );
        describeAbort.current = null;
        if (summary == null) return;
        setDescribeSummary(summary);
        // The new descriptions are only searchable once they are embedded. A cancelled run stops right there, the
        // Index card offers to reindex.
        if (summary.described > 0 && !summary.cancelled) await indexFolder();
    }, [runStep, indexFolder, describeClient]);

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
            setOpenedScript({ name, text: await session.readScript(name) });
        } catch (e) {
            logger.error('Failed to read script', { error: stringifyError(e), name }, LOG_CTX);
            setError(stringifyError(e));
        }
    }, [logger]);
    // Clicking the dot under the pointer opens its script, cards and the prompt are in front of the page
    const onClick = (e: React.MouseEvent<HTMLElement>) => {
        if (e.target === e.currentTarget && dotScript != null) void openScript(dotScript);
    };

    let layout: React.ReactNode;
    if (unsupported != null) {
        layout = (
            <div className={styles.workspace}>
                <div className={styles.step_area}>
                    <StepPanel title="Not supported">
                        <p>{unsupported}</p>
                    </StepPanel>
                </div>
            </div>
        );
    } else {
        layout = (
            <div className={openedScript == null ? styles.workspace : `${styles.workspace} ${styles.workspace_script}`}>
                <div className={styles.steps}>
                    {error != null && <div className={styles.error_banner} role="alert">{error}</div>}
                    <FolderCard
                        folder={folder}
                        setupStatus={view.kind === 'setup' ? view.status : null}
                        activity={activity}
                        onSelect={() => void selectFolder()}
                    />
                    <IndexCard folder={folder} activity={activity} onIndex={() => void indexFolder()} />
                    <DescribeCard
                        folder={folder}
                        activity={activity}
                        available={describeClient != null}
                        summary={describeSummary}
                        onDescribe={() => void describeFolder()}
                        onCancel={() => describeAbort.current?.abort()}
                    />
                </div>
                <div className={styles.search_column}>
                    <SearchCard
                        folder={folder}
                        prompt={prompt}
                        onPromptChange={setPrompt}
                        onSubmit={() => void submit()}
                        searching={searching}
                        results={results}
                        onHover={setHovered}
                        onOpen={name => void openScript(name)}
                        script={openedScript}
                        onCloseScript={() => setOpenedScript(null)}
                        onCloseResults={() => setResults(null)}
                    />
                </div>
                {index != null && index.rows.numRows > 0 && (
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

    let dot: DotTooltip | null = null;
    if (dotHover != null) {
        if (index == null) {
            dot = demoScript(dotHover);
        } else if (dotScript != null) {
            const tables = index.points.tables[dotHover] ?? [];
            dot = { name: dotScript, snippet: index.points.details[dotHover] ?? '', tables: tables.length > 0 ? tables : undefined };
        }
    }
    return (
        <main className={styles.page} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onClick={onClick}>
            <ParticleFlowBackground load={loadPointCloud} onAnimation={onAnimation} className={styles.cloud_stage} />
            {layout}
            {dot != null && (
                <div ref={tooltipRef} className={styles.dot_tooltip} role="tooltip">
                    <div className={styles.dot_name}>{dot.name}</div>
                    {dot.snippet !== '' && <div className={styles.dot_snippet}>{dot.snippet}</div>}
                    {dot.tables != null && <div className={styles.dot_tables}>{dot.tables.join(', ')}</div>}
                </div>
            )}
        </main>
    );
};

/// A centered note when the atlas cannot run
const StepPanel: React.FC<{ title: string; children: React.ReactNode }> = props => (
    <section className={styles.step}>
        <div className={styles.step_text}>
            <h1 className={styles.step_title}>{props.title}</h1>
            <div className={styles.step_body}>{props.children}</div>
        </div>
    </section>
);
