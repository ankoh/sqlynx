import * as React from 'react';
import * as dashql from '@ankoh/dashql-core';
import * as styles from './script_diagnostics.module.css';

import { AlertIcon, XCircleFillIcon, XIcon } from '../../../ui/foundations/symbol_icon.js';

import type { ScriptData } from '../scripts/session_scripts.js';
import { formattingDialectForConnector } from './script_format.js';
import type { ConnectorType } from '../connections/connector_info.js';
import { AnchorAlignment, AnchorSide } from '../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../ui/foundations/anchored_overlay.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { JsonView } from '../../../ui/json/json_view.js';
import { Overlay, OverlaySize } from '../../../ui/foundations/overlay.js';

export const SCRIPT_FORMATTING_WARNING = 'This script cannot be formatted';

export interface ScriptDiagnostic {
    severity: 'error' | 'warning';
    message: string;
    details: Record<string, unknown>;
}

function formattingDetails(scriptData: ScriptData, connectorType?: ConnectorType): Record<string, unknown> {
    const details: Record<string, unknown> = {
        source: 'formatter',
        severity: 'warning',
        message: SCRIPT_FORMATTING_WARNING,
        scriptKey: scriptData.scriptKey,
    };
    try {
        const dialect = formattingDialectForConnector(connectorType);
        const config = new dashql.buffers.formatting.FormattingConfigT(
            dialect,
            dashql.buffers.formatting.FormattingMode.PRETTY,
            80,
            4,
        );
        details.configuration = {
            dialect: dashql.buffers.formatting.FormattingDialect[dialect],
            mode: 'PRETTY',
            maxWidth: 80,
            indentationWidth: 4,
        };
        details.fullyFormattable = scriptData.scriptSession.isFullyFormattable(config, true);
    } catch (error) {
        details.inspectionError = error instanceof Error ? error.message : String(error);
    }
    return details;
}

export function collectScriptDiagnostics(scriptData: ScriptData, isFormattable: boolean,
    connectorType?: ConnectorType, formatting: Record<string, unknown> | null = null): ScriptDiagnostic[] {
    const diagnostics: ScriptDiagnostic[] = (scriptData.editorUpdate?.diagnostics ?? []).map(diagnostic => {
        const severity = diagnostic.severity === dashql.buffers.editor.EditorDiagnosticSeverity.WARNING
            ? 'warning'
            : 'error';
        const source = dashql.buffers.editor.EditorDiagnosticSource[diagnostic.source].toLowerCase();
        const span = diagnostic.textSpan;
        const textSpan = span == null ? null : {
            offset: Number(span.offset),
            length: Number(span.length),
            end: Number(span.offset + span.length),
        };
        const message = typeof diagnostic.message === 'string' ? diagnostic.message : '';
        return {
            severity,
            message,
            details: { source, severity, message, scriptKey: scriptData.scriptKey, textSpan },
        };
    });

    if (!isFormattable) {
        diagnostics.push({
            severity: 'warning',
            message: SCRIPT_FORMATTING_WARNING,
            details: formatting ?? formattingDetails(scriptData, connectorType),
        });
    }
    return diagnostics;
}

export const ScriptDiagnosticsButton: React.FC<{
    scriptData: ScriptData;
    isFormattable: boolean;
    connectorType?: ConnectorType;
}> = ({ scriptData, isFormattable, connectorType }) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [selectedDiagnostic, setSelectedDiagnostic] = React.useState<ScriptDiagnostic | null>(null);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    // Inspecting the formatter is a full pass over the script, only repeat it when the text changes
    const formatting = React.useMemo(
        () => isFormattable ? null : formattingDetails(scriptData, connectorType),
        [scriptData.scriptSession, scriptData.editorUpdate?.textVersion, isFormattable, connectorType],
    );
    const diagnostics = React.useMemo(
        () => collectScriptDiagnostics(scriptData, isFormattable, connectorType, formatting),
        [scriptData.editorUpdate, isFormattable, connectorType, formatting],
    );
    React.useEffect(() => {
        if (diagnostics.length === 0) {
            if (isOpen) setIsOpen(false);
            if (selectedDiagnostic != null) setSelectedDiagnostic(null);
        }
    }, [diagnostics.length, isOpen, selectedDiagnostic]);
    if (diagnostics.length === 0) return null;

    const hasErrors = diagnostics.some(diagnostic => diagnostic.severity === 'error');
    const errorCount = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length;
    const warningCount = diagnostics.length - errorCount;
    const label = hasErrors ? 'Show script errors' : 'Show script warnings';
    const summary = [
        errorCount > 0 ? `${errorCount} ${errorCount === 1 ? 'error' : 'errors'}` : null,
        warningCount > 0 ? `${warningCount} ${warningCount === 1 ? 'warning' : 'warnings'}` : null,
    ].filter(Boolean).join(', ');

    return (
        <>
            <AnchoredOverlay
                open={isOpen}
                onOpen={() => setIsOpen(true)}
                onClose={() => setIsOpen(false)}
                side={AnchorSide.OutsideBottom}
                align={AnchorAlignment.End}
                anchorOffset={4}
                width={OverlaySize.M}
                anchorRef={triggerRef}
                returnFocusRef={triggerRef}
                focusZoneSettings={{ disabled: true }}
                renderAnchor={(anchorProps) => (
                    <IconButton
                        {...anchorProps}
                        ref={triggerRef}
                        className={hasErrors ? styles.error_trigger : styles.warning_trigger}
                        variant={ButtonVariant.Invisible}
                        size={ButtonSize.Small}
                        aria-label={label}
                    >
                        {hasErrors
                            ? <XCircleFillIcon size={16} aria-hidden="true" />
                            : <AlertIcon size={16} aria-hidden="true" />}
                    </IconButton>
                )}
            >
                <section className={styles.overlay} role="dialog" aria-label="Script diagnostics">
                    <header className={styles.header}>
                        <h2 className={styles.title}>Script diagnostics</h2>
                        <span className={styles.summary}>{summary}</span>
                    </header>
                    <ul className={styles.list}>
                        {diagnostics.map((diagnostic, index) => (
                            <li key={`${diagnostic.severity}-${index}`}>
                                <button
                                    type="button"
                                    className={styles.item}
                                    onClick={() => {
                                        setIsOpen(false);
                                        setSelectedDiagnostic(diagnostic);
                                    }}
                                    aria-label={`Show details: ${diagnostic.message}`}
                                >
                                    <span
                                        className={diagnostic.severity === 'error' ? styles.error_icon : styles.warning_icon}
                                        aria-hidden="true"
                                    >
                                        {diagnostic.severity === 'error'
                                            ? <XCircleFillIcon size={16} />
                                            : <AlertIcon size={16} />}
                                    </span>
                                    <span className={styles.message}>{diagnostic.message}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            </AnchoredOverlay>
            {selectedDiagnostic != null && (
                <Overlay
                    centered
                    width={OverlaySize.L}
                    maxHeight={OverlaySize.XL}
                    returnFocusRef={triggerRef}
                    onEscape={() => setSelectedDiagnostic(null)}
                    onClickOutside={() => setSelectedDiagnostic(null)}
                >
                    <section className={styles.detail_overlay} role="dialog" aria-label="Diagnostic details">
                        <header className={styles.detail_header}>
                            <h2 className={styles.title}>Diagnostic details</h2>
                            <IconButton
                                variant={ButtonVariant.Invisible}
                                size={ButtonSize.Small}
                                aria-label="Close diagnostic details"
                                onClick={() => setSelectedDiagnostic(null)}
                            >
                                <XIcon size={16} />
                            </IconButton>
                        </header>
                        <div className={styles.json_details}>
                            <JsonView
                                value={selectedDiagnostic.details}
                                collapsed={2}
                                shortenTextAfterLength={100}
                            />
                        </div>
                    </section>
                </Overlay>
            )}
        </>
    );
};
