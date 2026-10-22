import * as React from 'react';
import * as styles from './cell_detail_overlay.module.css';
import * as dashql from '@ankoh/dashql-core';

import { EditorView } from '@codemirror/view';
import { XIcon, ChevronUpIcon, ChevronDownIcon, ScreenFullIcon, ScreenNormalIcon } from '../../../../../ui/foundations/symbol_icon.js';

import { ButtonSize, IconButton, ButtonVariant } from '../../../../../ui/foundations/button.js';
import { SegmentedControl, SegmentedControlSize } from '../../../../../ui/foundations/segmented_control.js';
import { SymbolIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { JsonView } from '../../../../../ui/json/json_view.js';
import { CodeMirror, createReadonlyCodeMirrorExtensions } from '../../../scripts/editor/codemirror.js';
import { DashQLUpdateEffect } from '../../../scripts/editor/dashql_processor.js';
import { Overlay, OverlaySize } from '../../../../../ui/foundations/overlay.js';
import { useDashQLCoreSetup } from '../../../../providers/core_provider.js';
import { CopyToClipboardButton } from '../../../../../utils/clipboard.js';
import { useKeyEvents } from '../../../../../utils/key_events.js';
import { peekFormat } from './format_peek.js';
import { useAppConfig } from '../../../../config/app_config.js';
import { getKeywordCase } from '../../../ui/script_format.js';
import { HyperPlanView } from '../plan/hyper_plan_view.js';

const LOG_CTX = 'cell_detail_overlay';

enum FormatMode {
    Raw = 0,
    Structured = 1,
    SQL = 2,
    Plan = 3,
}

const FORMAT_LABELS: Record<FormatMode, string> = {
    [FormatMode.Raw]: 'Raw',
    [FormatMode.Structured]: 'Structured',
    [FormatMode.SQL]: 'SQL',
    [FormatMode.Plan]: 'Plan',
};

interface DetectedFormats {
    json: object | null;
    sql: {
        originalText: string;
        originalUpdate: dashql.buffers.editor.EditorUpdateT;
        formattedText: string | null;
        formattedUpdate: dashql.buffers.editor.EditorUpdateT | null;
        hasErrors: boolean;
    } | null;
    plan: string | null;
}

function projectSqlText(
    core: dashql.DashQL,
    catalog: dashql.DashQLCatalog,
    text: string,
): dashql.buffers.editor.EditorUpdateT {
    const session = core.createScriptSession(catalog);
    try {
        session.replaceText(0n, text);
        return session.analyze();
    } finally {
        session.destroy();
    }
}

export function detectFormats(core: dashql.DashQL | null, value: string | null, keywordCase = dashql.buffers.formatting.KeywordCase.LOWER): DetectedFormats {
    const result: DetectedFormats = { json: null, sql: null, plan: null };
    if (value == null) return result;

    const peeked = peekFormat(value);
    if (peeked === 'plan') {
        result.plan = value;
    }

    if (peeked === 'plan' || peeked === 'json') {
        try {
            const parsed = JSON.parse(value);
            if (typeof parsed === 'object' && parsed !== null) {
                result.json = parsed;
            }
        } catch {
            // Not JSON
        }
    }

    // JSON is never meaningful SQL, skip scanning, parsing, analyzing and formatting large documents
    if (core != null && result.json == null) {
        let catalog: dashql.DashQLCatalog | null = null;
        let script: dashql.DashQLScript | null = null;
        let formattedScript: dashql.DashQLScript | null = null;
        try {
            catalog = core.createCatalog();
            script = core.createScript(catalog);
            script.insertTextAt(0, value);
            script.parse();
            const parsed = script.getParsed();
            const hasErrors = parsed != null && (parsed.read().scannerErrorsLength() > 0 || parsed.read().parserErrorsLength() > 0);
            parsed?.destroy();
            const originalUpdate = projectSqlText(core, catalog, value);
            let formattedText: string | null = null;
            let formattedUpdate: dashql.buffers.editor.EditorUpdateT | null = null;
            try {
                const config = new dashql.buffers.formatting.FormattingConfigT(
                    dashql.buffers.formatting.FormattingDialect.HYPER,
                    dashql.buffers.formatting.FormattingMode.PRETTY,
                    80,
                    4,
                    false,
                    keywordCase,
                );
                formattedScript = script.format(config, null);
                const text = formattedScript.toString();
                formattedUpdate = projectSqlText(core, catalog, text);
                formattedText = text;
            } catch {
                // Format failed, but parse succeeded
            }
            result.sql = { originalText: value, originalUpdate, formattedText, formattedUpdate, hasErrors };
            formattedScript?.ptr.destroy();
            script.ptr.destroy();
            catalog.ptr.destroy();
            return result;
        } catch {
            // Not valid SQL — destroy everything
            formattedScript?.ptr.destroy();
            script?.ptr.destroy();
            catalog?.ptr.destroy();
        }
    }

    return result;
}

export function detectStructuredFormats(value: object): DetectedFormats {
    return { json: value, sql: null, plan: null };
}

export const STRUCTURED_ARRAY_PAGE_SIZE = 100;

export function structuredValueToText(value: object): string {
    return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item, 2);
}

function pickDefaultMode(formats: DetectedFormats): FormatMode {
    if (formats.plan != null) return FormatMode.Plan;
    if (formats.sql != null && !formats.sql.hasErrors) return FormatMode.SQL;
    if (formats.json != null) return FormatMode.Structured;
    return FormatMode.Raw;
}

function getAvailableModes(formats: DetectedFormats): FormatMode[] {
    const modes: FormatMode[] = [FormatMode.Raw];
    if (formats.json != null) modes.push(FormatMode.Structured);
    if (formats.sql != null) modes.push(FormatMode.SQL);
    if (formats.plan != null) modes.push(FormatMode.Plan);
    return modes;
}

/// Read-only CodeMirror sub-view (no syntax highlighting)
function ReadonlyTextView(props: { text: string }) {
    const [view, setView] = React.useState<EditorView | null>(null);
    const readonlyExtensions = React.useMemo(() => [...createReadonlyCodeMirrorExtensions(), EditorView.lineWrapping], []);

    React.useEffect(() => {
        if (view == null) return;
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: props.text },
        });
    }, [view, props.text]);

    return (
        <div className={styles.codemirror_container}>
            <CodeMirror ref={setView} extensions={readonlyExtensions} style={{ height: 'auto' }} />
        </div>
    );
}

const PencilAIIcon = SymbolIcon('pencil_ai_16');

interface SqlTextViewProps {
    originalText: string;
    originalUpdate: dashql.buffers.editor.EditorUpdateT;
    formattedText: string | null;
    formattedUpdate: dashql.buffers.editor.EditorUpdateT | null;
}

// SQL CodeMirror sub-view (with DashQL syntax highlighting)
function SqlTextView(props: SqlTextViewProps) {
    const [view, setView] = React.useState<EditorView | null>(null);
    const readonlyExtensions = React.useMemo(() => createReadonlyCodeMirrorExtensions(), []);
    const [pretty, setPretty] = React.useState(false);

    const activeText = pretty && props.formattedText != null ? props.formattedText : props.originalText;
    const activeUpdate = pretty && props.formattedUpdate != null ? props.formattedUpdate : props.originalUpdate;

    React.useEffect(() => {
        if (view == null) return;
        const changes = { from: 0, to: view.state.doc.length, insert: activeText };
        view.dispatch({
            changes,
            effects: [
                DashQLUpdateEffect.of({
                    scriptKey: 0,
                    scriptSession: null,
                    editorUpdate: activeUpdate,
                    scriptBuffers: null,
                    scriptCompletion: null,
                    scriptPendingDiff: null,
                    derivedFocus: null,
                    onUpdate: () => { },
                }),
            ],
        });
    }, [view, activeText, activeUpdate]);

    return (
        <div className={styles.codemirror_container}>
            <CodeMirror ref={setView} extensions={readonlyExtensions} />
            {props.formattedText != null && (
                <div className={styles.pretty_toggle}>
                    <IconButton
                        className={styles.pretty_toggle_button}
                        variant={ButtonVariant.Default}
                        aria-label="Pretty format"
                        aria-pressed={pretty}
                        onClick={() => setPretty(p => !p)}
                    >
                        <PencilAIIcon />
                    </IconButton>
                </div>
            )}
        </div>
    );
}

function StructuredValueView(props: { value: object }) {
    return (
        <JsonView
            className={styles.structured_view}
            value={props.value}
            collapsed={2}
            shortenTextAfterLength={100}
            arrayPageSize={STRUCTURED_ARRAY_PAGE_SIZE}
        />
    );
}


export interface CellDetailOverlayProps {
    isOpen: boolean;
    onClose: () => void;
    formattedValue: string | null;
    structuredValue: object | null;
    columnName: string | null;
    dataRow: number;
    maxRow: number;
    onNavigate: (delta: number) => void;
}

/// Public interface
export function CellDetailOverlay(props: CellDetailOverlayProps) {
    if (!props.isOpen) return null;
    return <CellDetailOverlayInner {...props} />;
}


const EMPTY_FORMATS: DetectedFormats = { json: null, sql: null, plan: null };

/// Inner component — only mounted when overlay is open
function CellDetailOverlayInner(props: CellDetailOverlayProps) {
    const keywordCase = getKeywordCase(useAppConfig()?.settings);
    const coreSetup = useDashQLCoreSetup();
    const [core, setCore] = React.useState<dashql.DashQL | null>(null);
    const [formats, setFormats] = React.useState<DetectedFormats>(EMPTY_FORMATS);
    const [selectedFormat, setSelectedFormat] = React.useState<FormatMode>(FormatMode.Raw);
    const [expanded, setExpanded] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        coreSetup('cell_detail').then(c => {
            if (!cancelled) setCore(c);
        });
        return () => { cancelled = true; };
    }, [coreSetup]);

    React.useEffect(() => {
        const f = props.structuredValue == null
            ? detectFormats(core, props.formattedValue, keywordCase)
            : detectStructuredFormats(props.structuredValue);
        setFormats(f);
        setSelectedFormat(pickDefaultMode(f));
    }, [props.formattedValue, props.structuredValue, core, keywordCase]);

    const availableModes = React.useMemo(() => getAvailableModes(formats), [formats]);

    const onSegmentChange = React.useCallback((index: number) => {
        setSelectedFormat(availableModes[index]);
    }, [availableModes]);

    useKeyEvents(React.useMemo(() => [
        {
            key: 'ArrowUp',
            callback: (e: KeyboardEvent) => {
                e.preventDefault();
                if (props.dataRow > 0) {
                    props.onNavigate(-1);
                }
            },
        },
        {
            key: 'ArrowDown',
            callback: (e: KeyboardEvent) => {
                e.preventDefault();
                if (props.dataRow < props.maxRow) {
                    props.onNavigate(1);
                }
            },
        },
    ], [props.dataRow, props.maxRow, props.onNavigate]));

    const rawText = React.useMemo(() => props.structuredValue == null
        ? (props.formattedValue ?? 'NULL')
        : structuredValueToText(props.structuredValue), [props.structuredValue, props.formattedValue]);

    return (
        <Overlay
            centered
            onEscape={props.onClose}
            onClickOutside={props.onClose}
            preventFocusOnOpen
            width={OverlaySize.XL}
            maxHeight={OverlaySize.XL}
            expanded={expanded}
        >
            <div className={styles.modal} data-expanded={expanded || undefined}>
                <div className={styles.main}>
                    <div className={styles.header}>
                        <span className={styles.header_title}>
                            <span className={styles.header_title_label}>row</span>
                            <span className={styles.header_title_equal}>=</span>
                            <span className={styles.header_title_index}>{props.dataRow}</span>
                            <span className={styles.header_title_label}>field</span>
                            <span className={styles.header_title_equal}>=</span>
                            <span className={styles.header_title_field}>{props.columnName ?? 'value'}</span>
                        </span>
                        <div className={styles.header_spacer} />
                        <CopyToClipboardButton
                            variant={ButtonVariant.Invisible}
                            size={ButtonSize.Small}
                            value={rawText}
                            logContext={LOG_CTX}
                            aria-label="Copy raw output"
                            aria-labelledby=""
                        />
                        {availableModes.length > 1 && (
                            <SegmentedControl
                                aria-label="Format mode"
                                size={SegmentedControlSize.Small}
                                onChange={onSegmentChange}
                            >
                                {availableModes.map(mode => (
                                    <SegmentedControl.Button
                                        key={mode}
                                        selected={mode === selectedFormat}
                                    >
                                        {FORMAT_LABELS[mode]}
                                    </SegmentedControl.Button>
                                ))}
                            </SegmentedControl>
                        )}
                    </div>
                    <div className={`${styles.body} ${selectedFormat === FormatMode.Structured ? styles.body_padded : ''}`}>
                        {selectedFormat === FormatMode.Raw && (
                            <ReadonlyTextView text={rawText} />
                        )}
                        {selectedFormat === FormatMode.Structured && formats.json != null && (
                            <StructuredValueView value={formats.json} />
                        )}
                        {selectedFormat === FormatMode.SQL && formats.sql != null && (
                            <SqlTextView
                                originalText={formats.sql.originalText}
                                originalUpdate={formats.sql.originalUpdate}
                                formattedText={formats.sql.formattedText}
                                formattedUpdate={formats.sql.formattedUpdate}
                            />
                        )}
                        {selectedFormat === FormatMode.Plan && formats.plan != null && (
                            <HyperPlanView
                                planText={formats.plan}
                                className={styles.plan_container}
                                fallback={<div className={styles.plan_error}>Could not render plan</div>}
                            />
                        )}
                    </div>
                </div>
                <div className={styles.sidebar}>
                    <div className={styles.sidebar_top}>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label="Close"
                            onClick={props.onClose}
                        >
                            <XIcon />
                        </IconButton>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label={expanded ? 'Restore size' : 'Expand'}
                            aria-pressed={expanded}
                            onClick={() => setExpanded(e => !e)}
                        >
                            {expanded ? <ScreenNormalIcon /> : <ScreenFullIcon />}
                        </IconButton>
                    </div>
                    <div className={styles.sidebar_bottom}>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label="Previous row"
                            onClick={() => props.onNavigate(-1)}
                            disabled={props.dataRow <= 0}
                        >
                            <ChevronUpIcon />
                        </IconButton>
                        <IconButton
                            variant={ButtonVariant.Invisible}
                            aria-label="Next row"
                            onClick={() => props.onNavigate(1)}
                            disabled={props.dataRow >= props.maxRow}
                        >
                            <ChevronDownIcon />
                        </IconButton>
                    </div>
                </div>
            </div>
        </Overlay>
    );
}
