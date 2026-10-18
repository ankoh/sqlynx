import * as React from 'react';

import { useAppConfig } from '../app/config/app_config.js';
import { useDashQLCoreSetup } from '../app/providers/core_provider.js';
import { useEmbeddedDatabaseSetup } from '../platform/database/embedded_database_provider.js';
import { getHyperDBWebSupportError } from '../platform/hyperdb/hyperdb_web_support.js';
import { stringifyError } from '../platform/logger/logger.js';
import { useLogger } from '../platform/logger/logger_provider.js';
import { PlatformType, usePlatformType } from '../platform/platform_type.js';
import { useShellConnection } from '../shell/shell_connection.js';
import { selectPlatformDirectory } from '../shell/shell_files.js';
import * as baseStyles from '../ui/banner/banner_page.module.css';
import { Button, ButtonVariant } from '../ui/foundations/button.js';
import { SegmentedControl, SegmentedControlSize } from '../ui/foundations/segmented_control.js';
import { ParticleFlowBackground, type BackgroundAnimation, type BackgroundAnimationLoader } from '../ui/particle_flow/particle_flow_background.js';
import { AtlasSession, type AtlasPhase, type OpenedFolder } from './atlas_session.js';
import { DEFAULT_MODEL_BASE_URL } from './index/model.js';
import { demoScript } from './demo_data.js';
import type { DotHover, PointCloud } from './point_cloud.js';
import type { SearchResults } from './search/search.js';
import type { EmbeddingKind } from './store.js';
import * as styles from './atlas.module.css';

const LOG_CTX = 'atlas';

/// three.js is only loaded once the page is up
const loadPointCloud: BackgroundAnimationLoader = async () => (await import('./point_cloud.js')).PointCloud;

type View =
    | { kind: 'setup'; status: string }
    | { kind: 'pick' }
    | { kind: 'busy'; phase: AtlasPhase }
    | { kind: 'search' }
    | { kind: 'script'; name: string; text: string };

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

    const sessionRef = React.useRef<AtlasSession | null>(null);
    const [view, setView] = React.useState<View>({ kind: 'setup', status: 'Instantiating hyperdb-wasm' });
    const [error, setError] = React.useState<string | null>(null);
    const [folder, setFolder] = React.useState<OpenedFolder | null>(null);
    const [prompt, setPrompt] = React.useState('');
    const [searching, setSearching] = React.useState(false);
    const [results, setResults] = React.useState<SearchResults[] | null>(null);
    /// Which embeddings the cloud shows, features and comments have independent layouts
    const [kind, setKind] = React.useState<EmbeddingKind>('comments');
    const [cloud, setCloud] = React.useState<PointCloud | null>(null);
    /// The script of the candidate under the pointer
    const [hovered, setHovered] = React.useState<string | null>(null);
    /// The made up dot under the pointer, as long as no folder is open
    const [demoHover, setDemoHover] = React.useState<number | null>(null);
    const tooltipRef = React.useRef<HTMLDivElement>(null);
    const onAnimation = React.useCallback((animation: BackgroundAnimation | null) => setCloud(animation as PointCloud | null), []);

    // The made up dots only show until a folder is open, then the cloud is the embeddings of the index
    React.useEffect(() => {
        if (cloud == null) return;
        if (folder == null) cloud.clearPoints();
        else cloud.setPoints(folder.points[kind].coords);
    }, [cloud, folder, kind]);

    // The tooltip follows its dot while the cloud turns, which is too often for React
    React.useEffect(() => {
        if (cloud == null) return;
        cloud.setHoverListener((hover: DotHover | null) => {
            setDemoHover(hover?.index ?? null);
            const tooltip = tooltipRef.current;
            if (hover == null || tooltip == null) return;
            const flip = hover.x + 16 + tooltip.offsetWidth > window.innerWidth;
            tooltip.style.transform = `translate(${flip ? hover.x - 16 - tooltip.offsetWidth : hover.x + 16}px, ${hover.y + 16}px)`;
        });
        return () => cloud.setHoverListener(null);
    }, [cloud]);
    const onPointerMove = React.useCallback((e: React.PointerEvent<HTMLElement>) => {
        // Only the empty page hovers the cloud, cards and the prompt are in front of it
        cloud?.setPointer(e.target === e.currentTarget ? { x: e.clientX, y: e.clientY } : null);
    }, [cloud]);
    const onPointerLeave = React.useCallback(() => cloud?.setPointer(null), [cloud]);

    /// Every dot of a script: the features embedding and each comment chunk
    const pointsOfScript = React.useMemo(() => {
        const out = new Map<string, number[]>();
        const points = folder?.points[kind];
        if (points == null) return out;
        points.owners.forEach((owner, point) => {
            const name = points.scripts[owner];
            const list = out.get(name);
            if (list === undefined) out.set(name, [point]);
            else list.push(point);
        });
        return out;
    }, [folder, kind]);
    React.useEffect(() => {
        if (cloud == null) return;
        // The cloud turns again once the pointer leaves the candidate
        cloud.setRotationPaused(hovered != null);
        // Without a folder, the cloud highlights the dot under the pointer itself
        if (folder == null) return;
        const candidates: number[] = [];
        for (const { hits } of results ?? []) {
            for (const hit of hits) candidates.push(...pointsOfScript.get(hit.scriptName) ?? []);
        }
        cloud.setHighlight(candidates, hovered == null ? [] : pointsOfScript.get(hovered) ?? []);
    }, [cloud, folder, results, hovered, pointsOfScript]);

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
            setConnected(false);
            void session?.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unsupported]);

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
        setResults(null);
        setHovered(null);
        setFolder(null);
        setPrompt('');
        setView({ kind: 'busy', phase: { kind: 'mount', message: `Mounting ${handle.name}` } });
        try {
            const opened = await session.open(handle, phase => setView({ kind: 'busy', phase }));
            setKind(opened.points.comments.owners.length > 0 ? 'comments' : 'features');
            setFolder(opened);
            setView({ kind: 'search' });
        } catch (e) {
            logger.error('Failed to open folder', { error: stringifyError(e), name: handle.name, stack: e instanceof Error ? e.stack : undefined }, LOG_CTX);
            setError(stringifyError(e));
            setView({ kind: 'pick' });
        }
    }, [logger]);

    const submit = React.useCallback(async () => {
        const session = sessionRef.current;
        const text = prompt.trim();
        if (session == null || text.length === 0 || searching) return;
        setSearching(true);
        setError(null);
        setHovered(null);
        try {
            setResults(await session.search(text));
        } catch (e) {
            logger.error('Search failed', { error: stringifyError(e) }, LOG_CTX);
            setError(stringifyError(e));
        } finally {
            setSearching(false);
        }
    }, [prompt, searching, logger]);

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
                    Search the <code>.sql</code> files of a folder by what their comments and their SQL are about.
                    Everything stays in your browser, the index is written into the folder.
                </p>
                {error != null && <p className={styles.error}>{error}</p>}
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
                <div className={styles.kind_control}>
                    <SegmentedControl
                        aria-label="Embeddings in the cloud"
                        size={SegmentedControlSize.Small}
                        onChange={index => setKind(index === 0 ? 'comments' : 'features')}
                    >
                        <SegmentedControl.Button
                            selected={kind === 'comments'}
                            disabled={folder?.points.comments.owners.length === 0}
                            count={folder?.points.comments.owners.length}
                        >
                            Description
                        </SegmentedControl.Button>
                        <SegmentedControl.Button
                            selected={kind === 'features'}
                            disabled={folder?.points.features.owners.length === 0}
                            count={folder?.points.features.owners.length}
                        >
                            Features
                        </SegmentedControl.Button>
                    </SegmentedControl>
                </div>
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
                <div className={styles.prompt_area}>
                    {searching && <div className={styles.status}>Searching</div>}
                    {error != null && <div className={styles.error_banner}>{error}</div>}
                    <input
                        className={styles.prompt}
                        type="text"
                        autoFocus
                        value={prompt}
                        placeholder={`Search ${folder?.scripts ?? 0} scripts in ${folder?.name ?? 'the folder'}`}
                        aria-label="Search prompt"
                        disabled={searching}
                        onChange={e => setPrompt(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
                    />
                    <div className={styles.folder_actions}>
                        <Button variant={ButtonVariant.Invisible} onClick={selectFolder}>
                            {folder?.reused ? 'Using the existing index' : 'Index written'} · Select another folder
                        </Button>
                    </div>
                </div>
            </div>
        );
    }

    let layout: React.ReactNode;
    if (view.kind === 'search') {
        layout = content;
    } else if (view.kind === 'script') {
        layout = <div className={styles.foreground}>{content}</div>;
    } else {
        // The cards of the steps before the search sit where the prompt will be
        layout = (
            <div className={styles.workspace}>
                <div className={styles.prompt_area}>
                    {content}
                </div>
            </div>
        );
    }

    const dot = folder == null && demoHover != null ? demoScript(demoHover) : null;
    return (
        <main className={styles.page} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
            <ParticleFlowBackground load={loadPointCloud} onAnimation={onAnimation} />
            {layout}
            {dot != null && (
                <div ref={tooltipRef} className={styles.dot_tooltip} role="tooltip">
                    <div className={styles.hit_name}>{dot.name}</div>
                    <div className={styles.dot_snippet}>{dot.snippet}</div>
                    <div className={styles.dot_tables}>{dot.tables.join(', ')}</div>
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
