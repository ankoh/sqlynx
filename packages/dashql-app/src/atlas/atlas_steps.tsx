import * as React from 'react';

import { buffers, type DashQL, type DashQLScript } from '@ankoh/dashql-core';
import { EditorView } from '@codemirror/view';

import { updateReadonlyScriptEditor } from '../app/notebook/ui/catalog_script_card.js';
import { createScriptFormatConfig, measureScriptFormatWidth } from '../app/notebook/ui/script_format.js';
import { CodeMirror, createReadonlyCodeMirrorExtensions } from '../app/notebook/scripts/editor/codemirror.js';

import * as baseStyles from '../ui/banner/banner_page.module.css';
import { Button, ButtonSize, ButtonVariant } from '../ui/foundations/button.js';
import { ComposeIcon, FileDirectoryIcon, SearchIcon, SyncIcon, XIcon } from '../ui/foundations/symbol_icon.js';
import type { AtlasPhase, DescribeSummary, OpenedFolder } from './atlas_session.js';
import { PromptBar } from './prompt_bar.js';
import type { SearchResults } from './search/search.js';
import * as styles from './atlas_steps.module.css';

/// The step that is running, its card shows the progress and the other steps wait
export type AtlasActivity = { step: 'open' | 'index' | 'describe'; phase: AtlasPhase };

const plural = (n: number, one: string, many: string = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const ProgressBar: React.FC<{ fraction: number | null }> = ({ fraction }) => (
    <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={fraction ?? undefined}>
        <div
            className={fraction == null ? styles.progress_indeterminate : styles.progress_bar}
            style={fraction == null ? undefined : { width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }}
        />
    </div>
);

/// The progress of a phase, the phases without a fraction are indeterminate
const PhaseProgress: React.FC<{ phase: AtlasPhase }> = ({ phase }) => (
    <div className={styles.step_progress}>
        <div className={styles.step_progress_message}>{phase.message}</div>
        <ProgressBar fraction={'fraction' in phase ? phase.fraction : null} />
    </div>
);

type StatusTone = 'normal' | 'warning' | 'error';

interface StepCardProps {
    icon: React.ReactElement;
    title: string;
    status: React.ReactNode;
    tone?: StatusTone;
    action?: React.ReactNode;
    /// The running phase of the step
    phase?: AtlasPhase | null;
    /// The step does not apply yet
    dimmed?: boolean;
}

/// A brief card of one step, from selecting a folder to describing its scripts
const StepCard: React.FC<StepCardProps> = (props: StepCardProps) => {
    const statusClass = props.tone === 'error' ? styles.status_error : props.tone === 'warning' ? styles.status_warning : '';
    return (
        <section className={props.dimmed ? `${styles.step_card} ${styles.step_card_dimmed}` : styles.step_card} aria-label={props.title}>
            <div className={styles.step_row}>
                <span className={styles.step_icon}>{props.icon}</span>
                <div className={styles.step_text}>
                    <h2 className={styles.step_title}>{props.title}</h2>
                    <div className={`${styles.step_status} ${statusClass}`}>{props.status}</div>
                </div>
                {props.action != null && <div className={styles.step_action}>{props.action}</div>}
            </div>
            {props.phase != null && <PhaseProgress phase={props.phase} />}
        </section>
    );
};

interface FolderCardProps {
    folder: OpenedFolder | null;
    /// The database and the core are still loading
    setupStatus: string | null;
    activity: AtlasActivity | null;
    onSelect: () => void;
}

export const FolderCard: React.FC<FolderCardProps> = (props: FolderCardProps) => {
    const { folder } = props;
    const opening = props.activity?.step === 'open' ? props.activity.phase : null;
    let status: React.ReactNode;
    if (props.setupStatus != null) {
        status = props.setupStatus;
    } else if (folder == null) {
        status = 'Select a folder with .sql files. Everything stays in your browser, the index is written into the folder.';
    } else {
        status = (
            <>
                <span className={styles.folder_name}>{folder.name}</span>
                <span>{plural(folder.scripts, 'script')} · {folder.described} described</span>
            </>
        );
    }
    return (
        <StepCard
            icon={<FileDirectoryIcon />}
            title="Folder"
            status={status}
            phase={opening}
            action={(
                <Button
                    size={ButtonSize.Small}
                    variant={folder == null ? ButtonVariant.Primary : ButtonVariant.Default}
                    disabled={props.setupStatus != null || props.activity != null}
                    onClick={props.onSelect}
                >
                    {folder == null ? 'Select' : 'Change'}
                </Button>
            )}
        />
    );
};

interface IndexCardProps {
    folder: OpenedFolder | null;
    activity: AtlasActivity | null;
    onIndex: () => void;
}

export const IndexCard: React.FC<IndexCardProps> = (props: IndexCardProps) => {
    const { folder } = props;
    const index = folder?.index ?? null;
    let status: React.ReactNode;
    let tone: StatusTone = 'normal';
    if (folder == null) {
        status = 'Embeds the descriptions of the scripts for the search.';
    } else if (folder.indexError != null) {
        status = `${folder.indexError}. Indexing the folder replaces it.`;
        tone = 'error';
    } else if (index == null) {
        status = folder.described === 0
            ? 'Not indexed. Describe the scripts first, only described scripts are indexed.'
            : `Not indexed, ${plural(folder.described, 'described script')} would be indexed.`;
    } else if (index.outdated > 0) {
        status = `${plural(index.outdated, 'script was', 'scripts were')} added, changed or removed since the index was written.`;
        tone = 'warning';
    } else {
        status = `${plural(index.points.scripts.length, 'script')} indexed${index.reused ? '' : ', index written'}.`;
    }
    return (
        <StepCard
            icon={<SyncIcon />}
            title="Index"
            status={status}
            tone={tone}
            dimmed={folder == null}
            phase={props.activity?.step === 'index' ? props.activity.phase : null}
            action={(
                <Button
                    size={ButtonSize.Small}
                    variant={folder != null && index == null && folder.described > 0 ? ButtonVariant.Primary : ButtonVariant.Default}
                    disabled={folder == null || props.activity != null}
                    onClick={props.onIndex}
                >
                    {index == null ? 'Index' : 'Reindex'}
                </Button>
            )}
        />
    );
};

interface DescribeCardProps {
    folder: OpenedFolder | null;
    activity: AtlasActivity | null;
    /// A model is configured for describing
    available: boolean;
    /// The outcome of the last run
    summary: DescribeSummary | null;
    onDescribe: () => void;
    onCancel: () => void;
}

export const DescribeCard: React.FC<DescribeCardProps> = (props: DescribeCardProps) => {
    const { folder, summary } = props;
    const running = props.activity?.step === 'describe';
    let status: React.ReactNode;
    let tone: StatusTone = 'normal';
    if (folder == null) {
        status = 'Writes search descriptions into the scripts with an AI model.';
    } else if (!props.available) {
        status = 'Choose an external model for Describe in the AI settings.';
        tone = 'warning';
    } else if (summary != null && !running && (summary.failed > 0 || summary.skipped > 0 || summary.cancelled)) {
        const parts = [`Described ${summary.described}`];
        if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
        if (summary.failed > 0) parts.push(`${summary.failed} failed`);
        if (summary.cancelled) parts.push('stopped, reindex to search the new descriptions');
        else if (summary.stopped) parts.push('stopped');
        status = (
            <>
                <span>{parts.join(', ')}. The log has the details.</span>
                {summary.lastError != null && <span className={styles.last_error}>{summary.lastError}</span>}
            </>
        );
        tone = summary.failed > 0 ? 'error' : 'warning';
    } else if (folder.undescribed === 0) {
        status = 'Every script has a description.';
    } else {
        status = `${plural(folder.undescribed, 'script')} without a description.`;
    }
    let action: React.ReactNode;
    if (running) {
        action = <Button size={ButtonSize.Small} onClick={props.onCancel}>Stop</Button>;
    } else {
        action = (
            <Button
                size={ButtonSize.Small}
                variant={folder != null && folder.undescribed > 0 && props.available ? ButtonVariant.Primary : ButtonVariant.Default}
                disabled={folder == null || folder.undescribed === 0 || !props.available || props.activity != null}
                onClick={props.onDescribe}
            >
                Describe
            </Button>
        );
    }
    return (
        <StepCard
            icon={<ComposeIcon />}
            title="Describe"
            status={status}
            tone={tone}
            dimmed={folder == null}
            phase={running ? props.activity!.phase : null}
            action={action}
        />
    );
};

export const Card: React.FC<{ title: string; wide?: boolean; bare?: boolean; actions?: React.ReactNode; children: React.ReactNode }> = props => (
    <section className={`${baseStyles.card} ${styles.card} ${props.wide ? styles.card_wide : ''}`}>
        <div className={baseStyles.card_header}>
            <div className={baseStyles.card_header_left_container}>
                <h1 className={`${baseStyles.card_header_left_title} ${styles.card_title}`}>{props.title}</h1>
            </div>
            {props.actions != null && <div className={baseStyles.card_header_right_container}>{props.actions}</div>}
        </div>
        <div className={baseStyles.card_section}>
            <div className={`${baseStyles.section_entries} ${styles.card_body} ${props.bare ? styles.card_body_bare : ''}`}>{props.children}</div>
        </div>
    </section>
);

interface ScriptCardProps {
    core: DashQL | null;
    script: { name: string; text: string };
    onClose: () => void;
}

/// A script with syntax highlighting that can be formatted
const ScriptCard: React.FC<ScriptCardProps> = (props: ScriptCardProps) => {
    const [view, setView] = React.useState<EditorView | null>(null);
    const [pretty, setPretty] = React.useState(false);
    const extensions = React.useMemo(() => [...createReadonlyCodeMirrorExtensions(), EditorView.lineWrapping], []);
    const { core, script } = props;
    React.useEffect(() => {
        if (view == null || core == null) return;
        let text = script.text;
        if (pretty) text = formatSql(core, text, measureScriptFormatWidth(view)) ?? text;
        updateReadonlyScriptEditor(view, core, 0, text);
    }, [view, core, script.text, pretty]);
    return (
        <Card
            title={script.name}
            bare
            actions={(
                <>
                    {core != null && (
                        <Button
                            variant={pretty ? ButtonVariant.Primary : ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            aria-pressed={pretty}
                            onClick={() => setPretty(!pretty)}
                        >
                            Pretty
                        </Button>
                    )}
                    <Button
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label="Close script"
                        onClick={props.onClose}
                        leadingVisual={<XIcon />}
                    />
                </>
            )}
        >
            <CodeMirror ref={setView} extensions={extensions} style={{ height: 'auto' }} />
        </Card>
    );
};

/// Format SQL text with the pretty printer, null if it cannot be formatted
function formatSql(core: DashQL, text: string, width: number): string | null {
    const catalog = core.createCatalog();
    const session = core.createScriptSession(catalog);
    let formatted: DashQLScript | null = null;
    try {
        session.replaceText(0n, text);
        session.analyze();
        formatted = session.format(createScriptFormatConfig(buffers.formatting.FormattingMode.PRETTY, false, width), null);
        return formatted.toString();
    } catch {
        return null;
    } finally {
        formatted?.destroy();
        session.destroy();
        catalog.destroy();
    }
}

interface SearchCardProps {
    folder: OpenedFolder | null;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    onSubmit: () => void;
    searching: boolean;
    results: SearchResults[] | null;
    /// The script of the hit under the pointer
    onHover: (scriptName: string | null) => void;
    onOpen: (scriptName: string) => void;
    /// The script that was opened, it shows left of the best matches
    script: { name: string; text: string } | null;
    /// The dashql-core instance that highlights and formats the script
    core: DashQL | null;
    onCloseScript: () => void;
    onCloseResults: () => void;
}

/// The prompt of the semantic search and its best matches
export const SearchCard: React.FC<SearchCardProps> = (props: SearchCardProps) => {
    const index = props.folder?.index ?? null;
    const searchable = index != null && index.points.scripts.length > 0;
    let placeholder: string;
    if (searchable) placeholder = `Search ${plural(index.points.scripts.length, 'described script')}`;
    else if (props.folder == null) placeholder = 'Select a folder to search it';
    else placeholder = 'Index the folder to search it';
    return (
        <div className={styles.search}>
            <div className={styles.search_prompt}>
            <PromptBar
                value={props.prompt}
                onChange={props.onPromptChange}
                onSubmit={props.onSubmit}
                busy={props.searching}
                disabled={!searchable}
                placeholder={placeholder}
                info={(
                    <span className={styles.search_info}>
                        <SearchIcon size={12} />
                        {props.searching ? 'Searching' : searchable ? `Semantic search in ${props.folder!.name}` : 'Semantic search'}
                    </span>
                )}
            />
            </div>
            <div className={styles.search_below}>
            {props.script != null && (
                <div className={styles.script_card}>
                    <ScriptCard core={props.core} script={props.script} onClose={props.onCloseScript} />
                </div>
            )}
            {props.results != null && (
                <div className={styles.results}>
                    <Card
                        title="Best matches"
                        actions={(
                            <Button
                                variant={ButtonVariant.Invisible}
                                size={ButtonSize.Small}
                                aria-label="Close search results"
                                onClick={props.onCloseResults}
                                leadingVisual={<XIcon />}
                            />
                        )}
                    >
                        {props.results.map(({ strategy, hits }) => (
                            <section key={strategy.id} className={styles.result_section} aria-label={strategy.title}>
                                <h2 className={styles.result_title}>{strategy.title}</h2>
                                {hits.length === 0 && <div className={styles.no_hits}>No matches</div>}
                                {hits.map(hit => (
                                    <button
                                        key={hit.scriptName}
                                        type="button"
                                        className={styles.hit}
                                        onClick={() => props.onOpen(hit.scriptName)}
                                        onMouseEnter={() => props.onHover(hit.scriptName)}
                                        onMouseLeave={() => props.onHover(null)}
                                        onFocus={() => props.onHover(hit.scriptName)}
                                        onBlur={() => props.onHover(null)}
                                    >
                                        <span className={styles.hit_name}>{hit.scriptName}</span>
                                        <span className={styles.hit_score}>{hit.score.toFixed(3)}</span>
                                        <span className={styles.hit_snippet}>{hit.snippet}</span>
                                    </button>
                                ))}
                            </section>
                        ))}
                    </Card>
                </div>
            )}
            </div>
        </div>
    );
};
