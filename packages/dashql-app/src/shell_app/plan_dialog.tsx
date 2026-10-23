import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as themes from '../app/session/scripts/editor/themes/index.js';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';

import { createPlanLayoutConfig, PlanView, type PlanViewProps } from '../app/session/compute/ui/plan/plan_view.js';
import { CodeMirror } from '../app/session/scripts/editor/codemirror.js';
import type { PlatformEventListener } from '../platform/events/event_listener.js';
import { ButtonSize, ButtonVariant, IconButton } from '../ui/foundations/button.js';
import { useFocusTrap } from '../ui/foundations/focus.js';
import { Overlay, OverlaySize } from '../ui/foundations/overlay.js';
import { SegmentedControl, SegmentedControlSize } from '../ui/foundations/segmented_control.js';
import { AlertIcon, XIcon } from '../ui/foundations/symbol_icon.js';
import * as styles from './plan_dialog.module.css';

const IGNORE_OUTSIDE_CLICK = () => {};
/// Edits are parsed once the user pauses typing, loading the plan per keystroke is too expensive
const VALIDATION_DELAY_MS = 150;

const enum PlanMode {
    Raw = 0,
    Viewer = 1,
}

interface PlanResources {
    core: dashql.DashQL;
}

interface PendingRequest {
    resolve: () => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export interface PlanDialogController {
    request(core: dashql.DashQL, signal?: AbortSignal): Promise<void>;
}

export interface PlanDialogHookResult {
    controller: PlanDialogController;
    dialog: React.ReactElement | null;
}

type PlanDialogEvents = Pick<PlatformEventListener, 'subscribeFallbackPasteEvents' | 'unsubscribeFallbackPasteEvents'>;

export interface PlanDialogDependencies {
    createPlanLayoutConfig: typeof createPlanLayoutConfig;
    PlanView: React.ComponentType<PlanViewProps>;
}

const DEFAULT_DEPENDENCIES: PlanDialogDependencies = {
    createPlanLayoutConfig,
    PlanView,
};

export function usePlanDialog(
    appEvents: PlanDialogEvents,
    dependencies: PlanDialogDependencies = DEFAULT_DEPENDENCIES,
): PlanDialogHookResult {
    const [resources, setResources] = React.useState<PlanResources | null>(null);
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

    const request = React.useCallback((core: dashql.DashQL, signal?: AbortSignal) => {
        if (pendingRequestRef.current != null) {
            return Promise.reject(new Error('A query plan request is already pending.'));
        }
        if (signal?.aborted) return Promise.resolve();

        setResources({ core });
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

    const controller = React.useMemo<PlanDialogController>(() => ({ request }), [request]);
    return {
        controller,
        dialog: resources == null ? null : (
            <PlanDialog
                appEvents={appEvents}
                core={resources.core}
                dependencies={dependencies}
                onClose={dismiss}
            />
        ),
    };
}

interface PlanDialogProps extends PlanResources {
    appEvents: PlanDialogEvents;
    dependencies: PlanDialogDependencies;
    onClose: () => void;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function PlanDialog(props: PlanDialogProps) {
    const PlanViewComponent = props.dependencies.PlanView;
    const headingId = React.useId();
    const dialogRef = React.useRef<HTMLElement>(null);
    const editorFocusRef = React.useRef<HTMLElement>(null);
    const editorViewRef = React.useRef<EditorView | null>(null);
    const rawTextRef = React.useRef('');
    const viewModelRef = React.useRef<dashql.DashQLPlanViewModel | null>(null);
    const [mode, setMode] = React.useState(PlanMode.Raw);
    const [plan, setPlan] = React.useState<dashql.FlatBufferPtr<dashql.buffers.view.PlanViewModel> | null>(null);
    const [diagnostic, setDiagnostic] = React.useState<string | null>(null);
    const onRawChangeRef = React.useRef<(text: string) => void>(() => {});
    const rawTextIsValidRef = React.useRef(false);
    const layoutConfig = React.useMemo(() => props.dependencies.createPlanLayoutConfig(false), [props.dependencies]);

    const validate = React.useCallback((text: string): boolean => {
        setPlan(null);
        if (text.trim().length === 0) {
            setDiagnostic(null);
            return false;
        }

        viewModelRef.current ??= props.core.createPlanViewModel(layoutConfig);
        try {
            const nextPlan = viewModelRef.current.loadHyperPlan(text);
            if (nextPlan.read().operatorsLength() === 0) {
                throw new Error('Plan contains no operators');
            }
            setPlan(nextPlan);
            setDiagnostic(null);
            return true;
        } catch (error) {
            setDiagnostic(errorMessage(error));
            return false;
        }
    }, [layoutConfig, props.core]);

    const validationTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const cancelValidation = React.useCallback(() => {
        if (validationTimerRef.current != null) {
            clearTimeout(validationTimerRef.current);
            validationTimerRef.current = null;
        }
    }, []);
    const runValidation = React.useCallback(() => {
        cancelValidation();
        rawTextIsValidRef.current = validate(rawTextRef.current);
    }, [cancelValidation, validate]);
    // Validate pending edits right away, e.g. before showing the viewer
    const flushValidation = React.useCallback(() => {
        if (validationTimerRef.current != null) runValidation();
    }, [runValidation]);

    onRawChangeRef.current = text => {
        rawTextRef.current = text;
        cancelValidation();
        validationTimerRef.current = setTimeout(runValidation, VALIDATION_DELAY_MS);
    };

    const extensions = React.useMemo<Extension[]>(() => [
        themes.xcode.xcodeLight,
        lineNumbers(),
        drawSelection(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ 'aria-label': 'Query plan JSON' }),
        EditorView.updateListener.of(update => {
            if (update.docChanged) onRawChangeRef.current(update.state.doc.toString());
        }),
    ], []);

    const setView = React.useCallback((view: EditorView | null) => {
        editorViewRef.current = view;
        editorFocusRef.current = view?.contentDOM ?? null;
        view?.focus();
    }, []);

    React.useEffect(() => () => {
        // A pending validation must not load a plan into the destroyed view model
        cancelValidation();
        viewModelRef.current?.destroy();
        viewModelRef.current = null;
    }, [cancelValidation]);

    React.useEffect(() => {
        const handleFallbackPaste = (text: string) => {
            const view = editorViewRef.current;
            if (view?.contentDOM.isConnected) {
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
            } else {
                onRawChangeRef.current(text);
            }
            flushValidation();
            if (rawTextIsValidRef.current) setMode(PlanMode.Viewer);
        };
        props.appEvents.subscribeFallbackPasteEvents(handleFallbackPaste);
        return () => props.appEvents.unsubscribeFallbackPasteEvents(handleFallbackPaste);
    }, [props.appEvents, flushValidation]);

    const selectMode = React.useCallback((nextMode: PlanMode) => {
        flushValidation();
        // The viewer button was enabled for the text before the pending edits
        if (nextMode === PlanMode.Viewer && !rawTextIsValidRef.current) return;
        setMode(nextMode);
    }, [flushValidation]);

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
                    <h2 id={headingId} className={styles.title}>Query Plan</h2>
                    <div className={styles.spacer} />
                    {diagnostic != null && (
                        <div className={styles.diagnostic} role="alert" title={diagnostic}>
                            <AlertIcon size={16} aria-hidden="true" />
                            <span className={styles.diagnostic_text}>{diagnostic}</span>
                        </div>
                    )}
                    <SegmentedControl
                        aria-label="Plan view"
                        size={SegmentedControlSize.Small}
                        onChange={index => selectMode(index as PlanMode)}
                    >
                        <SegmentedControl.Button selected={mode === PlanMode.Raw}>Raw</SegmentedControl.Button>
                        <SegmentedControl.Button
                            selected={mode === PlanMode.Viewer}
                            disabled={plan == null}
                        >
                            Viewer
                        </SegmentedControl.Button>
                    </SegmentedControl>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label="Close query plan"
                        onClick={props.onClose}
                    >
                        <XIcon size={16} />
                    </IconButton>
                </header>
                <div className={styles.body}>
                    {mode === PlanMode.Raw && (
                        <div className={styles.editor}>
                            <CodeMirror ref={setView} extensions={extensions} initialDoc={rawTextRef.current} />
                        </div>
                    )}
                    {mode === PlanMode.Viewer && plan != null && (
                        <div className={styles.viewer}>
                            <PlanViewComponent plan={plan} autoFocus />
                        </div>
                    )}
                </div>
            </section>
        </Overlay>
    );
}
