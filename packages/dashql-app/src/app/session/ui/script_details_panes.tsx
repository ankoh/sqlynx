import * as React from 'react';
import * as styles from './script_details.module.css';

import type { EditorView } from '@codemirror/view';
import type { Icon } from '../../../ui/foundations/symbol_icon.js';
import { PaperAirplaneIcon } from '../../../ui/foundations/symbol_icon.js';

import type { QueryExecutionState } from '../connections/query_execution_state.js';
import type { ScriptData } from '../scripts/session_scripts.js';
import type { ConnectorType } from '../connections/connector_info.js';
import type { ResolvedVisualizeQuery } from '../scripts/script_types.js';
import { ButtonGroup } from '../../../ui/foundations/button_group.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../ui/foundations/button.js';
import { ScriptDiagnosticsButton } from './script_diagnostics.js';
import { ScriptEditor } from './script_editor.js';
import { ScriptName } from './script_name.js';
import { ScriptOutputDetails, type ScriptDetailsTab } from './script_output_details.js';
import { ScriptStatisticsBar } from './script_statistics_bar.js';
import { ExecuteConnectionGuard } from './session_connection_attention.js';

interface ScriptDetailsEditorPaneProps {
    sessionId: string;
    scriptData: ScriptData;
    scriptDisplay: string;
    scriptDebugMode: boolean;
    executeDisabled: boolean;
    connectionBlocked: boolean;
    isEditingName: boolean;
    draftFileName: string;
    editInputRef: React.RefObject<HTMLInputElement | null>;
    isFormattable: boolean;
    connectorType: ConnectorType;
    hasPendingDiff: boolean;
    PencilIcon: Icon;
    CheckIcon: Icon;
    CancelIcon: Icon;
    CollapseIcon: Icon;
    formatMenu: React.ReactNode;
    onExecute: () => void;
    onHide: () => void;
    onStartEditingName: (event?: React.MouseEvent) => void;
    onDraftFileNameChange: (value: string) => void;
    onSaveName: () => void;
    onCancelName: () => void;
    onEditorView: (view: EditorView) => void;
    onNavigateToScript: (scriptKey: number) => void;
    onAcceptDiff: () => void;
    onRejectDiff: () => void;
}

export const ScriptDetailsEditorPane: React.FC<ScriptDetailsEditorPaneProps> = (props) => (
    <div className={styles.entry_script_section}>
        <div className={styles.entry_card_action_bar}>
            <ExecuteConnectionGuard sessionId={props.sessionId} blocked={props.connectionBlocked}>
            <IconButton
                variant={ButtonVariant.Invisible}
                size={ButtonSize.Small}
                aria-label={`Execute ${props.scriptDisplay} query`}
                disabled={props.executeDisabled}
                onClick={props.onExecute}
            >
                <PaperAirplaneIcon size={16} />
            </IconButton>
            </ExecuteConnectionGuard>
            <div className={styles.entry_card_file_name}>
                <ScriptName
                    file={props.scriptDisplay}
                    onFileClick={props.onStartEditingName}
                    editing={props.isEditingName ? {
                        value: props.draftFileName,
                        onChange: props.onDraftFileNameChange,
                        onCommit: props.onSaveName,
                        onCancel: props.onCancelName,
                        inputRef: props.editInputRef,
                    } : undefined}
                    fileNameTrailing={(
                        <span className={styles.entry_card_file_name_actions}>
                            <IconButton
                                variant={ButtonVariant.Invisible}
                                size={ButtonSize.Tiny}
                                aria-label="Rename script"
                                onClick={props.onStartEditingName}
                                className={styles.entry_card_file_name_action_button}
                            >
                                <props.PencilIcon size={12} />
                            </IconButton>
                        </span>
                    )}
                />
            </div>
            {props.scriptDebugMode && (
                <div className={styles.entry_card_stats_bar}>
                    <ScriptStatisticsBar stats={props.scriptData.statistics} />
                </div>
            )}
            <div className={styles.entry_card_trailing_actions}>
                <ScriptDiagnosticsButton scriptData={props.scriptData} isFormattable={props.isFormattable}
                    connectorType={props.connectorType} />
                {props.formatMenu}
                <IconButton
                    className={styles.entry_card_collapse_button}
                    variant={ButtonVariant.Invisible}
                    onClick={props.onHide}
                    aria-label="Shrink script details"
                >
                    <props.CollapseIcon size={16} />
                </IconButton>
            </div>
        </div>
        <div className={styles.script_body}>
            <div className={styles.editor_container}>
                <ScriptEditor
                    sessionId={props.sessionId}
                    scriptKey={props.scriptData.scriptKey}
                    setView={props.onEditorView}
                    onNavigateToScript={props.onNavigateToScript}
                />
                <div className={styles.format_toggle}>
                    {props.hasPendingDiff ? (
                        <ButtonGroup>
                            <IconButton variant={ButtonVariant.Default} onClick={props.onAcceptDiff} aria-label="Accept rewrite">
                                <props.CheckIcon />
                            </IconButton>
                            <IconButton variant={ButtonVariant.Default} onClick={props.onRejectDiff} aria-label="Reject rewrite">
                                <props.CancelIcon />
                            </IconButton>
                        </ButtonGroup>
                    ) : null}
                </div>
            </div>
        </div>
    </div>
);

interface ScriptDetailsOutputPaneProps {
    query: QueryExecutionState | null;
    visualizeQuery: ResolvedVisualizeQuery | null;
    initialTab?: ScriptDetailsTab;
    tableDebugMode: boolean;
    statusActions: React.ReactNode;
    onCancelQuery?: () => void;
    expanded: boolean;
    onToggleExpanded: () => void;
    contentId: string;
}

export const ScriptDetailsOutputPane: React.FC<ScriptDetailsOutputPaneProps> = (props) => (
    <ScriptOutputDetails
        className={styles.entry_output_section}
        embedded
        query={props.query}
        visualizeQuery={props.visualizeQuery}
        initialTab={props.initialTab}
        tableDebugMode={props.tableDebugMode}
        onCancelQuery={props.onCancelQuery}
        expanded={props.expanded}
        onToggleExpanded={props.onToggleExpanded}
        contentId={props.contentId}
        statusActions={props.statusActions}
    />
);
