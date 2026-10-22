import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as themes from '../app/session/scripts/editor/themes/index.js';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';

import { CodeMirror } from '../app/session/scripts/editor/codemirror.js';
import {
    DashQLScannerDecorationUpdateEffect,
    DashQLStandaloneScannerDecorationPlugin,
} from '../app/session/scripts/editor/dashql_decorations_standalone.js';
import { ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { useFocusTrap } from '../ui/foundations/focus.js';
import { Overlay, OverlaySize } from '../ui/foundations/overlay.js';
import { AlertIcon, XIcon } from '../ui/foundations/symbol_icon.js';
import { CopyToClipboardButton } from '../utils/clipboard.js';
import { buildShareUrl, encodeShareScript } from './shell_share.js';
import * as styles from './share_dialog.module.css';

const IGNORE_OUTSIDE_CLICK = () => {};
/// The URL is encoded once the user pauses typing, deflating the script per keystroke is wasted work
const SHARE_URL_DELAY_MS = 150;

interface ShareResources {
    core: dashql.DashQL;
    catalog: dashql.DashQLCatalog;
}

interface PendingRequest {
    resolve: () => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export interface ShareDialogController {
    request(core: dashql.DashQL, catalog: dashql.DashQLCatalog, signal?: AbortSignal): Promise<void>;
}

export interface ShareDialogHookResult {
    controller: ShareDialogController;
    dialog: React.ReactElement | null;
}

export function useShareDialog(): ShareDialogHookResult {
    const [resources, setResources] = React.useState<ShareResources | null>(null);
    const pendingRequestRef = React.useRef<PendingRequest | null>(null);
    /// The script of the last dialog, reopening the dialog continues with it
    const scriptRef = React.useRef('');

    const dismiss = React.useCallback(() => {
        const pending = pendingRequestRef.current;
        pendingRequestRef.current = null;
        if (pending?.signal != null && pending.onAbort != null) {
            pending.signal.removeEventListener('abort', pending.onAbort);
        }
        setResources(null);
        pending?.resolve();
    }, []);

    const request = React.useCallback((
        core: dashql.DashQL,
        catalog: dashql.DashQLCatalog,
        signal?: AbortSignal,
    ) => {
        if (pendingRequestRef.current != null) {
            return Promise.reject(new Error('A share request is already pending.'));
        }
        if (signal?.aborted) return Promise.resolve();

        setResources({ core, catalog });
        return new Promise<void>(resolve => {
            const pending: PendingRequest = { resolve, signal };
            pending.onAbort = dismiss;
            pendingRequestRef.current = pending;
            signal?.addEventListener('abort', pending.onAbort, { once: true });
        });
    }, [dismiss]);

    React.useEffect(() => () => {
        const pending = pendingRequestRef.current;
        pendingRequestRef.current = null;
        if (pending?.signal != null && pending.onAbort != null) {
            pending.signal.removeEventListener('abort', pending.onAbort);
        }
        pending?.resolve();
    }, []);

    const controller = React.useMemo<ShareDialogController>(() => ({ request }), [request]);
    return {
        controller,
        dialog: resources == null ? null : (
            <ShareDialog core={resources.core} catalog={resources.catalog} scriptRef={scriptRef} onClose={dismiss} />
        ),
    };
}

interface ShareDialogProps extends ShareResources {
    scriptRef: React.RefObject<string>;
    onClose: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function scanSql(core: dashql.DashQL, catalog: dashql.DashQLCatalog, text: string): dashql.buffers.editor.EditorUpdateT | null {
    if (text.length === 0) return null;
    const session = core.createScriptSession(catalog);
    try {
        session.replaceText(0n, text);
        return session.analyze();
    } catch {
        return null;
    } finally {
        session.destroy();
    }
}

function ShareDialog(props: ShareDialogProps) {
    const headingId = React.useId();
    const urlLabelId = React.useId();
    const dialogRef = React.useRef<HTMLElement>(null);
    const editorFocusRef = React.useRef<HTMLElement>(null);
    const editorViewRef = React.useRef<EditorView | null>(null);
    const initialDocRef = React.useRef(props.scriptRef.current);
    const textRef = React.useRef(props.scriptRef.current);
    const onChangeRef = React.useRef<(text: string) => void>(() => {});
    const updateTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    /// Encoding is asynchronous, only the result of the latest update is shown
    const updateSequenceRef = React.useRef(0);
    const [url, setUrl] = React.useState<string | null>(null);
    const [diagnostic, setDiagnostic] = React.useState<string | null>(null);

    const cancelUpdate = React.useCallback(() => {
        if (updateTimerRef.current != null) {
            clearTimeout(updateTimerRef.current);
            updateTimerRef.current = null;
        }
    }, []);

    // The core and the catalog belong to the request, never update after the dialog is gone
    React.useEffect(() => () => {
        cancelUpdate();
        updateSequenceRef.current += 1;
    }, [cancelUpdate]);

    // Update the decorations of the editor and encode the script as URL
    const runUpdate = React.useCallback(() => {
        cancelUpdate();
        const text = textRef.current;
        const sequence = ++updateSequenceRef.current;
        const view = editorViewRef.current;
        if (view != null && view.state.doc.toString() === text) {
            view.dispatch({ effects: DashQLScannerDecorationUpdateEffect.of(scanSql(props.core, props.catalog, text)) });
        }
        if (text.trim().length === 0) {
            setUrl(null);
            setDiagnostic(null);
            return;
        }
        encodeShareScript(text).then(
            payload => {
                if (sequence !== updateSequenceRef.current) return;
                setUrl(buildShareUrl(payload));
                setDiagnostic(null);
            },
            error => {
                if (sequence !== updateSequenceRef.current) return;
                setUrl(null);
                setDiagnostic(errorMessage(error));
            },
        );
    }, [cancelUpdate, props.catalog, props.core]);

    onChangeRef.current = (text: string) => {
        textRef.current = text;
        props.scriptRef.current = text;
        cancelUpdate();
        updateTimerRef.current = setTimeout(runUpdate, SHARE_URL_DELAY_MS);
    };

    const extensions = React.useMemo<Extension[]>(() => [
        themes.xcode.xcodeLight,
        lineNumbers(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...DashQLStandaloneScannerDecorationPlugin,
        EditorView.contentAttributes.of({ 'aria-label': 'Shared SQL script editor' }),
        EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
    ], []);

    const setView = React.useCallback((view: EditorView | null) => {
        editorViewRef.current = view;
        editorFocusRef.current = view?.contentDOM ?? null;
        if (view != null && textRef.current.length > 0) runUpdate();
        view?.focus();
    }, [runUpdate]);

    useFocusTrap({
        containerRef: dialogRef as React.RefObject<HTMLElement>,
        initialFocusRef: editorFocusRef as React.RefObject<HTMLElement>,
        restoreFocusOnCleanUp: true,
    });

    return (
        <Overlay
            centered
            width={OverlaySize.XXL}
            height={OverlaySize.XL}
            maxHeight={OverlaySize.XL}
            preventFocusOnOpen
            onEscape={props.onClose}
            onClickOutside={IGNORE_OUTSIDE_CLICK}
        >
            <section
                ref={dialogRef}
                className={styles.dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby={headingId}
            >
                <header className={styles.header}>
                    <h2 id={headingId} className={styles.title}>Share Script</h2>
                    <div className={styles.spacer} />
                    {diagnostic != null && (
                        <div className={styles.diagnostic} role="alert" title={diagnostic}>
                            <AlertIcon size={16} aria-hidden="true" />
                            <span className={styles.diagnostic_text}>{diagnostic}</span>
                        </div>
                    )}
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label="Close share dialog"
                        onClick={props.onClose}
                    >
                        <XIcon size={16} />
                    </IconButton>
                </header>
                <div className={styles.url_bar}>
                    <span id={urlLabelId} className={styles.url_label}>URL</span>
                    <output
                        className={url == null ? styles.url_placeholder : styles.url}
                        aria-labelledby={urlLabelId}
                        title={url ?? undefined}
                    >
                        {url ?? 'Enter SQL to generate a link'}
                    </output>
                    <span className={styles.url_length} aria-label="URL length">
                        {url?.length ?? 0} characters
                    </span>
                    <CopyToClipboardButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        value={url ?? ''}
                        disabled={url == null}
                        aria-label="Copy share URL"
                        aria-labelledby=""
                        logContext="shell_share"
                    />
                </div>
                <div className={styles.editor}>
                    <CodeMirror ref={setView} extensions={extensions} initialDoc={initialDocRef.current} />
                </div>
            </section>
        </Overlay>
    );
}
