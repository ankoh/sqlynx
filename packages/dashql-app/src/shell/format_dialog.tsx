import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as themes from '../app/notebook/scripts/editor/themes/index.js';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';

import { createScriptFormatConfig, getKeywordCase, measureScriptFormatWidth } from '../app/notebook/ui/script_format.js';
import { useAppConfig } from '../app/config/app_config.js';
import { CodeMirror } from '../app/notebook/scripts/editor/codemirror.js';
import {
    DashQLScannerDecorationUpdateEffect,
    DashQLStandaloneScannerDecorationPlugin,
} from '../app/notebook/scripts/editor/dashql_decorations_standalone.js';
import { ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { useFocusTrap } from '../ui/foundations/focus.js';
import { Overlay, OverlaySize } from '../ui/foundations/overlay.js';
import { SegmentedControl, SegmentedControlSize } from '../ui/foundations/segmented_control.js';
import { AlertIcon, XIcon } from '../ui/foundations/symbol_icon.js';
import * as styles from './format_dialog.module.css';

const IGNORE_OUTSIDE_CLICK = () => {};

const enum FormatMode {
    Raw = 0,
    Compact = 1,
    Pretty = 2,
}

const FORMAT_LABELS = ['Raw', 'Compact', 'Pretty'] as const;

interface FormatResources {
    core: dashql.DashQL;
    catalog: dashql.DashQLCatalog;
}

interface PendingRequest {
    resolve: () => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export interface FormatDialogController {
    request(core: dashql.DashQL, catalog: dashql.DashQLCatalog, signal?: AbortSignal): Promise<void>;
}

export interface FormatDialogHookResult {
    controller: FormatDialogController;
    dialog: React.ReactElement | null;
}

export function useFormatDialog(): FormatDialogHookResult {
    const [resources, setResources] = React.useState<FormatResources | null>(null);
    const pendingRequestRef = React.useRef<PendingRequest | null>(null);

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
            return Promise.reject(new Error('A SQL formatter request is already pending.'));
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

    const controller = React.useMemo<FormatDialogController>(() => ({ request }), [request]);
    return {
        controller,
        dialog: resources == null ? null : (
            <FormatDialog core={resources.core} catalog={resources.catalog} onClose={dismiss} />
        ),
    };
}

interface FormatDialogProps extends FormatResources {
    onClose: () => void;
}

interface ValidationResult {
    update: dashql.buffers.editor.EditorUpdateT | null;
    diagnostic: string | null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function bufferString(value: string | Uint8Array | null | undefined, fallback: string): string {
    if (typeof value === 'string') return value || fallback;
    return value == null ? fallback : new TextDecoder().decode(value) || fallback;
}

function analyzeSql(
    core: dashql.DashQL,
    catalog: dashql.DashQLCatalog,
    text: string,
    compactWidth: number,
): ValidationResult {
    if (text.length === 0) return { update: null, diagnostic: null };

    const session = core.createScriptSession(catalog);
    const script = core.createScript(catalog);
    let parsed: dashql.FlatBufferPtr<dashql.buffers.parser.ParsedScript> | null = null;
    try {
        session.replaceText(0n, text);
        const update = session.analyze();
        script.replaceText(text);
        script.parse();
        parsed = script.getParsed();
        const parsedReader = parsed.read();
        if (parsedReader.scannerErrorsLength() > 0) {
            return {
                update,
                diagnostic: bufferString(parsedReader.scannerErrors(0)?.message(), 'SQL could not be scanned'),
            };
        }
        if (parsedReader.parserErrorsLength() > 0) {
            return {
                update,
                diagnostic: bufferString(parsedReader.parserErrors(0)?.message(), 'SQL could not be parsed'),
            };
        }
        if (update.status !== dashql.buffers.editor.EditorUpdateStatus.OK || !update.analysisAvailable) {
            return { update, diagnostic: bufferString(update.statusMessage, 'SQL could not be parsed') };
        }
        const compactConfig = createScriptFormatConfig(
            dashql.buffers.formatting.FormattingMode.COMPACT,
            false,
            compactWidth,
        );
        const prettyConfig = createScriptFormatConfig(dashql.buffers.formatting.FormattingMode.PRETTY);
        if (!script.isFullyFormattable(compactConfig, false) || !script.isFullyFormattable(prettyConfig, false)) {
            return { update, diagnostic: 'This SQL contains syntax that cannot be formatted' };
        }
        return { update, diagnostic: null };
    } catch (error) {
        return { update: null, diagnostic: errorMessage(error) };
    } finally {
        parsed?.destroy();
        script.destroy();
        session.destroy();
    }
}

function formatSql(
    core: dashql.DashQL,
    catalog: dashql.DashQLCatalog,
    text: string,
    mode: FormatMode,
    compactWidth: number,
    keywordCase: dashql.buffers.formatting.KeywordCase,
): string {
    if (text.length === 0) return '';

    const session = core.createScriptSession(catalog);
    let formatted: dashql.DashQLScript | null = null;
    try {
        session.replaceText(0n, text);
        const formattingMode = mode === FormatMode.Compact
            ? dashql.buffers.formatting.FormattingMode.COMPACT
            : dashql.buffers.formatting.FormattingMode.PRETTY;
        const width = mode === FormatMode.Compact ? compactWidth : 80;
        const config = createScriptFormatConfig(formattingMode, false, width, keywordCase);
        formatted = session.format(config);
        return formatted.toString();
    } finally {
        formatted?.destroy();
        session.destroy();
    }
}

function FormatDialog(props: FormatDialogProps) {
    const keywordCase = getKeywordCase(useAppConfig()?.settings);
    const headingId = React.useId();
    const dialogRef = React.useRef<HTMLElement>(null);
    const editorFocusRef = React.useRef<HTMLElement>(null);
    const editorViewRef = React.useRef<EditorView | null>(null);
    const rawTextRef = React.useRef('');
    const rawUpdateRef = React.useRef<dashql.buffers.editor.EditorUpdateT | null>(null);
    const changingViewRef = React.useRef(false);
    const [mode, setMode] = React.useState(FormatMode.Raw);
    const [diagnostic, setDiagnostic] = React.useState<string | null>(null);
    const readonlyCompartmentRef = React.useRef(new Compartment());
    const editableCompartmentRef = React.useRef(new Compartment());
    const attributesCompartmentRef = React.useRef(new Compartment());
    const onRawChangeRef = React.useRef<(text: string) => void>(() => {});

    const measureWidth = React.useCallback(() => {
        const view = editorViewRef.current;
        return view == null ? 80 : measureScriptFormatWidth(view);
    }, []);

    const validateRaw = React.useCallback((text: string) => {
        const validation = analyzeSql(props.core, props.catalog, text, measureWidth());
        rawUpdateRef.current = validation.update;
        setDiagnostic(validation.diagnostic);
        return validation;
    }, [measureWidth, props.catalog, props.core]);

    onRawChangeRef.current = (text: string) => {
        rawTextRef.current = text;
        const validation = validateRaw(text);
        queueMicrotask(() => {
            const view = editorViewRef.current;
            if (view == null || changingViewRef.current || view.state.doc.toString() !== rawTextRef.current) return;
            view.dispatch({ effects: DashQLScannerDecorationUpdateEffect.of(validation.update) });
        });
    };

    const extensions = React.useMemo<Extension[]>(() => [
        themes.xcode.xcodeLight,
        lineNumbers(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        ...DashQLStandaloneScannerDecorationPlugin,
        readonlyCompartmentRef.current.of(EditorState.readOnly.of(false)),
        editableCompartmentRef.current.of(EditorView.editable.of(true)),
        attributesCompartmentRef.current.of(EditorView.contentAttributes.of({
            'aria-label': 'SQL formatter editor',
            'aria-readonly': 'false',
        })),
        EditorView.updateListener.of(update => {
            if (update.docChanged && !changingViewRef.current) {
                onRawChangeRef.current(update.state.doc.toString());
            }
        }),
    ], []);

    const setView = React.useCallback((view: EditorView | null) => {
        editorViewRef.current = view;
        editorFocusRef.current = view?.contentDOM ?? null;
        view?.focus();
    }, []);

    const showMode = React.useCallback((nextMode: FormatMode, refresh = false) => {
        const view = editorViewRef.current;
        if (view == null || (nextMode === mode && !refresh)) return;

        let text = rawTextRef.current;
        let update = rawUpdateRef.current;
        let readonly = false;
        if (nextMode !== FormatMode.Raw) {
            const validation = validateRaw(text);
            if (validation.diagnostic != null) {
                setMode(FormatMode.Raw);
                return;
            }
            try {
                text = formatSql(props.core, props.catalog, text, nextMode, measureWidth(), keywordCase);
                update = analyzeSql(props.core, props.catalog, text, measureWidth()).update;
                readonly = true;
            } catch (error) {
                setDiagnostic(errorMessage(error));
                setMode(FormatMode.Raw);
                return;
            }
        }

        changingViewRef.current = true;
        try {
            view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: text },
                effects: [
                    readonlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(readonly)),
                    editableCompartmentRef.current.reconfigure(EditorView.editable.of(!readonly)),
                    attributesCompartmentRef.current.reconfigure(EditorView.contentAttributes.of({
                        'aria-label': `SQL formatter editor, ${FORMAT_LABELS[nextMode]} view`,
                        'aria-readonly': String(readonly),
                    })),
                    DashQLScannerDecorationUpdateEffect.of(update),
                ],
            });
        } finally {
            changingViewRef.current = false;
        }
        setMode(nextMode);
    }, [measureWidth, mode, props.catalog, props.core, validateRaw, keywordCase]);

    const renderedCase = React.useRef(keywordCase);
    React.useEffect(() => {
        if (renderedCase.current !== keywordCase && mode !== FormatMode.Raw) showMode(mode, true);
        renderedCase.current = keywordCase;
    }, [keywordCase, mode, showMode]);

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
                    <h2 id={headingId} className={styles.title}>SQL Formatter</h2>
                    <div className={styles.spacer} />
                    {diagnostic != null && (
                        <div className={styles.diagnostic} role="alert" title={diagnostic}>
                            <AlertIcon size={16} aria-hidden="true" />
                            <span className={styles.diagnostic_text}>{diagnostic}</span>
                        </div>
                    )}
                    <SegmentedControl
                        aria-label="Format mode"
                        size={SegmentedControlSize.Small}
                        onChange={index => showMode(index as FormatMode)}
                    >
                        {FORMAT_LABELS.map((label, index) => (
                            <SegmentedControl.Button
                                key={label}
                                selected={mode === index}
                                disabled={index !== FormatMode.Raw && diagnostic != null}
                            >
                                {label}
                            </SegmentedControl.Button>
                        ))}
                    </SegmentedControl>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label="Close SQL formatter"
                        onClick={props.onClose}
                    >
                        <XIcon size={16} />
                    </IconButton>
                </header>
                <div className={styles.editor}>
                    <CodeMirror ref={setView} extensions={extensions} />
                </div>
            </section>
        </Overlay>
    );
}
