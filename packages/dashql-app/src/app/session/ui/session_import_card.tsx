import * as React from 'react';

import * as baseStyles from '../../../ui/banner/banner_page.module.css';
import { Button, ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { ProgressBar } from '../../../ui/foundations/progress_bar.js';
import { IndicatorStatus, StatusIndicator } from '../../../ui/foundations/status_indicator.js';
import { AlertIcon, XIcon } from '../../../ui/foundations/symbol_icon.js';
import { ParticleFlowBackground } from '../../../ui/particle_flow/particle_flow_background.js';
import { formatBytes } from '../../../utils/format.js';
import type { SessionBundle } from '../../storage/session_bundle.js';
import { CompactNavBar } from '../../ui/navbar.js';
import { useAppFlavor } from '../../flavor/flavor_provider.js';
import type { HttpSessionLoadProgress, HttpSessionLoadResult } from '../persistence/http_session_bundle.js';
import * as styles from './session_import_card.module.css';

interface LoadingState {
    phase: 'loading';
    sourceUrl: string;
    progress: HttpSessionLoadProgress;
    onClose(): void;
}

interface ReadyState {
    phase: 'ready';
    result: HttpSessionLoadResult;
    conflictLocation: string | null;
    conflictIsNative: boolean;
    busy: boolean;
    onImport(): void;
    onReplace(): void;
    onCreateNew(): void;
    onClose(): void;
}

interface ConflictState {
    phase: 'conflict';
    sessionName: string;
    sessionUuid: string;
    existingLocation: string;
    existingIsNative: boolean;
    folderCount: number;
    scriptCount: number;
    busy: boolean;
    onReplace(): void;
    onCreateNew(): void;
    onClose(): void;
}

export type SessionFileLoadStage = 'reading' | 'validating';
export type SessionFileFailureStage = SessionFileLoadStage | 'importing';

interface FileLoadingState {
    phase: 'file-loading';
    sourcePath: string;
    stage: SessionFileLoadStage;
    fileByteCount: number | null;
    onClose(): void;
}

interface FileReadyState {
    phase: 'file-ready';
    sourcePath: string;
    fileByteCount: number;
    bundle: SessionBundle;
    busy: boolean;
    onImport(): void;
    onClose(): void;
}

interface FileErrorState {
    phase: 'file-error';
    sourcePath: string;
    fileByteCount: number | null;
    failedStage: SessionFileFailureStage;
    errorMessage: string;
    onRetry(): void;
    onClose(): void;
}

export type SessionImportCardState = LoadingState | ReadyState | ConflictState
    | FileLoadingState | FileReadyState | FileErrorState;

export interface SessionImportCardDependencies {
    CompactNavBar: typeof CompactNavBar;
    ParticleFlowBackground: typeof ParticleFlowBackground;
}

const DEFAULT_DEPENDENCIES: SessionImportCardDependencies = {
    CompactNavBar,
    ParticleFlowBackground,
};

export type SessionImportCardProps = SessionImportCardState & {
    dependencies?: SessionImportCardDependencies;
};

export function SessionImportCard(props: SessionImportCardProps): React.ReactElement {
    const dependencies = props.dependencies ?? DEFAULT_DEPENDENCIES;
    if (props.phase === 'loading') return <LoadingCard state={props} dependencies={dependencies} />;
    if (props.phase === 'conflict') return <ConflictCard state={props} dependencies={dependencies} />;
    if (props.phase === 'file-loading') return <FileLoadingCard state={props} dependencies={dependencies} />;
    if (props.phase === 'file-ready') return <FileReadyCard state={props} dependencies={dependencies} />;
    if (props.phase === 'file-error') return <FileErrorCard state={props} dependencies={dependencies} />;
    return <ReadyCard state={props} dependencies={dependencies} />;
}

function LoadingCard({ state, dependencies }: { state: LoadingState; dependencies: SessionImportCardDependencies }): React.ReactElement {
    const details = progressDetails(state.progress);
    const fileProgress = state.progress.phase === 'files' ? state.progress : null;
    const percentage = fileProgress == null
        ? null
        : fileProgress.completedFileCount / fileProgress.totalFileCount * 100;
    return (
        <CardShell title="Loading Session" busy onClose={state.onClose} dependencies={dependencies}>
            <div className={styles.status} role="status" aria-live="polite">
                <span aria-hidden="true">
                    <StatusIndicator status={IndicatorStatus.Running} width="18px" height="18px" />
                </span>
                <span>{details.status}</span>
            </div>
            {percentage != null && (
                <ProgressBar
                    progress={percentage}
                    aria-label="Session files loaded"
                    aria-valuetext={`${fileProgress!.completedFileCount} of ${fileProgress!.totalFileCount} files`}
                />
            )}
            <SessionImportDetails>
                {details.sessionName != null && <SessionImportDetail label="Session">{details.sessionName}</SessionImportDetail>}
                {details.sessionId != null && <SessionImportDetail label="UUID" mono>{details.sessionId}</SessionImportDetail>}
                <SessionImportDetail label="Source" mono>{state.sourceUrl}</SessionImportDetail>
            </SessionImportDetails>
        </CardShell>
    );
}

function ReadyCard({ state, dependencies }: { state: ReadyState; dependencies: SessionImportCardDependencies }): React.ReactElement {
    const { bundle, indexedScriptCount, loadedScriptCount, incomplete } = state.result;
    const sessionName = bundle.session.name?.trim() || bundle.session.metadata.originalFileName || 'Unnamed session';
    const scriptCount = incomplete
        ? indexedScriptCount > 0 ? `${loadedScriptCount} of ${indexedScriptCount}` : `${loadedScriptCount} (index unavailable)`
        : String(loadedScriptCount);
    const displayedScriptCount = incomplete && indexedScriptCount > 0 ? indexedScriptCount : loadedScriptCount;
    const scriptSummary = formatScriptSummary(scriptCount, displayedScriptCount, 0);
    const hasConflict = state.conflictLocation != null;
    const actions = hasConflict ? (
        <>
            <Button disabled={state.busy} onClick={state.onReplace}>Replace</Button>
            <Button disabled={state.busy} onClick={state.onCreateNew}>Create New</Button>
        </>
    ) : (
        <Button autoFocus variant={ButtonVariant.Primary} disabled={state.busy} onClick={state.onImport}>Import</Button>
    );

    return (
        <CardShell title="Import Session" busy={state.busy} closeDisabled={state.busy} onClose={state.onClose} actions={actions} dependencies={dependencies}>
            {hasConflict && <ConflictWarning native={state.conflictIsNative} />}
            {incomplete && (
                <div className={styles.warning} role="status">
                    <AlertIcon size={16} aria-hidden="true" />
                    <span>Some session files could not be resolved. The available content will still be imported.</span>
                </div>
            )}
            <SessionImportDetails>
                {state.conflictLocation != null && <SessionImportDetail label="Existing" mono>{state.conflictLocation}</SessionImportDetail>}
                <SessionImportDetail label="Source" mono>{bundle.session.metadata.originalHttpUrl}</SessionImportDetail>
                <SessionImportDetail label="UUID" mono>{bundle.session.sessionId}</SessionImportDetail>
                <SessionImportDetail label="Name">{sessionName}</SessionImportDetail>
                <SessionImportDetail label="Scripts">{scriptSummary}</SessionImportDetail>
            </SessionImportDetails>
        </CardShell>
    );
}

function FileLoadingCard({ state, dependencies }: { state: FileLoadingState; dependencies: SessionImportCardDependencies }): React.ReactElement {
    const status = state.stage === 'reading' ? 'Reading session file...' : 'Checking the session archive...';
    return (
        <CardShell title="Loading Session" busy onClose={state.onClose} dependencies={dependencies}>
            <div className={styles.status} role="status" aria-live="polite">
                <span aria-hidden="true">
                    <StatusIndicator status={IndicatorStatus.Running} width="18px" height="18px" />
                </span>
                <span>{status}</span>
            </div>
            <SessionImportDetails>
                <SessionImportDetail label="File" mono>{state.sourcePath}</SessionImportDetail>
                {state.fileByteCount != null && <SessionImportDetail label="Size">{formatBytes(state.fileByteCount)}</SessionImportDetail>}
            </SessionImportDetails>
        </CardShell>
    );
}

function FileReadyCard({ state, dependencies }: { state: FileReadyState; dependencies: SessionImportCardDependencies }): React.ReactElement {
    const sessionName = state.bundle.session.name?.trim()
        || state.bundle.session.metadata.originalFileName
        || 'Unnamed session';
    return (
        <CardShell
            title="Import Session"
            busy={state.busy}
            closeDisabled={state.busy}
            onClose={state.onClose}
            actions={<Button autoFocus variant={ButtonVariant.Primary} disabled={state.busy} onClick={state.onImport}>Import</Button>}
            dependencies={dependencies}
        >
            {state.busy ? (
                <div className={styles.status} role="status" aria-live="polite">
                    <span aria-hidden="true"><StatusIndicator status={IndicatorStatus.Running} width="18px" height="18px" /></span>
                    <span>Adding the session to DashQL...</span>
                </div>
            ) : null}
            <SessionImportDetails>
                <SessionImportDetail label="File" mono>{state.sourcePath}</SessionImportDetail>
                <SessionImportDetail label="Size">{formatBytes(state.fileByteCount)}</SessionImportDetail>
                <SessionImportDetail label="Session">{sessionName}</SessionImportDetail>
                <SessionImportDetail label="UUID" mono>{state.bundle.session.sessionId}</SessionImportDetail>
                <SessionImportDetail label="Scripts">{formatCount(state.bundle.scripts.length, 'script')}</SessionImportDetail>
            </SessionImportDetails>
        </CardShell>
    );
}

function FileErrorCard({ state, dependencies }: { state: FileErrorState; dependencies: SessionImportCardDependencies }): React.ReactElement {
    const flavor = useAppFlavor();
    const summary = state.failedStage === 'reading'
        ? `${flavor.displayName} could not read this file.`
        : state.failedStage === 'validating'
            ? `This file is not a valid ${flavor.displayName} session archive.`
            : `${flavor.displayName} could not import this session.`;
    return (
        <CardShell
            title="Session Import Failed"
            onClose={state.onClose}
            actions={<Button autoFocus variant={ButtonVariant.Primary} onClick={state.onRetry}>Try Again</Button>}
            dependencies={dependencies}
        >
            <div className={styles.error} role="alert">
                <AlertIcon size={16} aria-hidden="true" />
                <div>
                    <div className={styles.errorSummary}>{summary}</div>
                    <div className={styles.errorDetail}>{state.errorMessage}</div>
                </div>
            </div>
            <SessionImportDetails>
                <SessionImportDetail label="File" mono>{state.sourcePath}</SessionImportDetail>
                {state.fileByteCount != null && <SessionImportDetail label="Size">{formatBytes(state.fileByteCount)}</SessionImportDetail>}
            </SessionImportDetails>
        </CardShell>
    );
}

function ConflictCard({ state, dependencies }: { state: ConflictState; dependencies: SessionImportCardDependencies }): React.ReactElement {
    return (
        <CardShell
            title="Import Session"
            busy={state.busy}
            closeDisabled={state.busy}
            onClose={state.onClose}
            actions={<>
                <Button disabled={state.busy} onClick={state.onReplace}>Replace</Button>
                <Button disabled={state.busy} onClick={state.onCreateNew}>Create New</Button>
            </>}
            dependencies={dependencies}
        >
            <ConflictWarning native={state.existingIsNative} />
            <SessionImportDetails>
                <SessionImportDetail label="Existing" mono>{state.existingLocation}</SessionImportDetail>
                <SessionImportDetail label="UUID" mono>{state.sessionUuid}</SessionImportDetail>
                <SessionImportDetail label="Name">{state.sessionName}</SessionImportDetail>
                <SessionImportDetail label="Scripts">{formatScriptSummary(String(state.scriptCount), state.scriptCount, state.folderCount)}</SessionImportDetail>
            </SessionImportDetails>
        </CardShell>
    );
}

function ConflictWarning({ native }: { native: boolean }): React.ReactElement {
    return (
        <div className={styles.warning} role="status">
            <AlertIcon size={16} aria-hidden="true" />
            <span>
                A session with this UUID already exists. Replace it, or create a new session with a different UUID.
                {native && ' Replacing removes the old session without overwriting existing native files.'}
            </span>
        </div>
    );
}

interface ShellProps {
    title: string;
    children: React.ReactNode;
    actions?: React.ReactNode;
    busy?: boolean;
    closeDisabled?: boolean;
    onClose?: () => void;
    dependencies: SessionImportCardDependencies;
}

function CardShell(props: ShellProps): React.ReactElement {
    const { CompactNavBar: NavBar, ParticleFlowBackground: Background } = props.dependencies;
    return (
        <div className={`${baseStyles.page} ${styles.page}`} data-electron-drag-region>
            <Background />
            <NavBar />
            <main className={`${baseStyles.banner_and_content_container} ${styles.foreground}`}>
                <div className={baseStyles.content_container}>
                    <section className={`${baseStyles.card} ${styles.card}`} aria-labelledby="session-import-card-title" aria-busy={props.busy || undefined}>
                        <div className={baseStyles.card_header} data-electron-drag-region>
                            <div className={baseStyles.card_header_left_container}>
                                <h1 id="session-import-card-title" className={`${baseStyles.card_header_left_title} ${styles.title}`}>{props.title}</h1>
                            </div>
                            {props.onClose != null && (
                                <div className={baseStyles.card_header_right_container}>
                                    <IconButton aria-label="Close" disabled={props.closeDisabled} size={ButtonSize.Small} variant={ButtonVariant.Invisible} onClick={props.onClose}>
                                        <XIcon size={16} />
                                    </IconButton>
                                </div>
                            )}
                        </div>
                        <div className={baseStyles.card_section}>
                            <div className={baseStyles.section_entries}>{props.children}</div>
                            {props.actions != null && <div className={baseStyles.card_actions}><div className={baseStyles.card_actions_right}>{props.actions}</div></div>}
                        </div>
                    </section>
                </div>
            </main>
        </div>
    );
}

function SessionImportDetails(props: React.PropsWithChildren): React.ReactElement {
    return <dl className={styles.details}>{props.children}</dl>;
}

function SessionImportDetail(props: { label: string; children: React.ReactNode; mono?: boolean }): React.ReactElement {
    return <><dt>{props.label}</dt><dd className={props.mono ? styles.mono : undefined}>{props.children}</dd></>;
}

function formatScriptSummary(count: string, numericCount: number, folderCount: number): string {
    return `${count} ${numericCount === 1 ? 'script' : 'scripts'} in ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`;
}

function formatCount(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function progressDetails(progress: HttpSessionLoadProgress): { status: string; sessionName: string | null; sessionId: string | null } {
    switch (progress.phase) {
        case 'preparing': return { status: 'Preparing session loader...', sessionName: null, sessionId: null };
        case 'manifest': return { status: 'Loading session manifest...', sessionName: null, sessionId: null };
        case 'index': return { status: 'Discovering session files...', sessionName: progress.sessionName, sessionId: progress.sessionId };
        case 'files': return {
            status: progress.totalScriptCount === 0 ? 'No indexed scripts' : `Loading scripts: ${progress.completedScriptCount} of ${progress.totalScriptCount}`,
            sessionName: progress.sessionName,
            sessionId: progress.sessionId,
        };
    }
}
