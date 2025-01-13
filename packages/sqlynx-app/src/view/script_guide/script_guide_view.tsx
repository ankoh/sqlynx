import { ContextObjectID } from '@ankoh/sqlynx-core';

import * as sqlynx from '@ankoh/sqlynx-core';
import * as React from 'react';
import * as styles from './script_guide_view.module.css';

import { CatalogViewer } from '../catalog/catalog_viewer.js';
import { FOCUSED_COMPLETION, FOCUSED_EXPRESSION_ID, FOCUSED_TABLE_REF_ID } from '../../session/focus.js';
import { useCurrentSessionState } from '../../session/current_session.js';
import { ScriptKey } from '../../session/session_state.js';
import { U32_MAX } from '../../utils/numeric_limits.js';

interface ScriptGuideViewProps { }

export function ScriptGuideView(_props: ScriptGuideViewProps) {
    const [sessionState, _dispatchSession] = useCurrentSessionState();

    // Collect overlay metrics
    const overlayEntries = React.useMemo<[string, string][]>(() => {
        const overlay: [string, string][] = [];

        // Inspect the cursor
        const cursor = sessionState?.scripts[ScriptKey.MAIN_SCRIPT].cursor;
        if (cursor && cursor.scannerSymbolId != U32_MAX) {
            const scanned = sessionState?.scripts[ScriptKey.MAIN_SCRIPT].processed.scanned?.read();
            const tokens = scanned?.tokens();
            if (tokens) {
                const tokenTypes = tokens.tokenTypesArray()!;
                const tokenType = tokenTypes[cursor.scannerSymbolId];
                const tokenTypeName = sqlynx.getScannerTokenTypeName(tokenType);

                overlay.push([
                    "Token",
                    tokenTypeName
                ]);
            }
        }

        // Is there a user focus?
        const focusTarget = sessionState?.userFocus?.focusTarget;
        switch (focusTarget?.type) {
            case FOCUSED_TABLE_REF_ID: {
                const tableRefObject = focusTarget.value.tableReference;
                const scriptKey = ContextObjectID.getContext(tableRefObject);
                const tableRefId = ContextObjectID.getObject(tableRefObject);
                const scriptData = sessionState?.scripts[scriptKey];
                const analyzed = scriptData?.processed.analyzed;
                if (analyzed) {
                    const analyzedPtr = analyzed.read();
                    const tableRef = analyzedPtr.tableReferences(tableRefId)!;
                    switch (tableRef.innerType()) {
                        case sqlynx.proto.TableReferenceSubType.ResolvedRelationExpression: {
                            const inner = new sqlynx.proto.ResolvedRelationExpression();
                            tableRef.inner(inner) as sqlynx.proto.ResolvedRelationExpression;
                            const tableName = inner.tableName();
                            overlay.push(["Table", tableName?.tableName() ?? ""]);
                            break;
                        }
                        case sqlynx.proto.TableReferenceSubType.UnresolvedRelationExpression: {
                            overlay.push(["Table", "<unresolved>"]);
                            break;
                        }
                    }
                }
                break;
            }
            case FOCUSED_EXPRESSION_ID: {
                const expressionObject = focusTarget.value.expression;
                const scriptKey = ContextObjectID.getContext(expressionObject);
                const expressionId = ContextObjectID.getObject(expressionObject);
                const scriptData = sessionState?.scripts[scriptKey];
                const analyzed = scriptData?.processed.analyzed;
                if (analyzed) {
                    const analyzedPtr = analyzed.read();
                    const expression = analyzedPtr.expressions(expressionId)!;
                    switch (expression.innerType()) {
                        case sqlynx.proto.ExpressionSubType.ResolvedColumnRefExpression: {
                            const inner = new sqlynx.proto.ResolvedColumnRefExpression();
                            expression.inner(inner) as sqlynx.proto.ResolvedColumnRefExpression;
                            overlay.push(["Expression", "column reference"]);
                            const columnName = inner.columnName();
                            overlay.push(["Column", columnName?.columnName() ?? ""]);
                            break;
                        }
                        case sqlynx.proto.ExpressionSubType.UnresolvedColumnRefExpression: {
                            const inner = new sqlynx.proto.UnresolvedColumnRefExpression();
                            expression.inner(inner) as sqlynx.proto.UnresolvedColumnRefExpression;
                            overlay.push(["Expression", "column reference"]);
                            overlay.push(["Column", "<unresolved>"]);
                            break;
                        }
                    }
                }
                break;
            }
            case FOCUSED_COMPLETION: {
                switch (focusTarget.value.completion.strategy) {
                    case sqlynx.proto.CompletionStrategy.DEFAULT:
                        overlay.push(["Completion", "Default"]);
                        break;
                    case sqlynx.proto.CompletionStrategy.TABLE_REF:
                        overlay.push(["Completion", "Table Reference"]);
                        break;
                    case sqlynx.proto.CompletionStrategy.COLUMN_REF:
                        overlay.push(["Completion", "Column Reference"]);
                        break;
                }
                const completionCandidate = focusTarget.value.completion.candidates[focusTarget.value.completionCandidateIndex];
                overlay.push(["Candidate Score", `${completionCandidate.score}`]);
                break;
            }
        }

        return overlay;
    }, [sessionState?.userFocus, sessionState?.scripts[ScriptKey.MAIN_SCRIPT]?.cursor]);

    const overlayScriptEntries: React.ReactElement[] = [];
    for (let i = 0; i < overlayEntries.length; ++i) {
        const [key, value] = overlayEntries[i];
        overlayScriptEntries.push(
            <span key={2 * i + 0} className={styles.overlay_body_list_key}>
                {key}
            </span>
        );
        overlayScriptEntries.push(
            <span key={2 * i + 1} className={styles.overlay_body_list_value}>
                {value}
            </span>
        );
    }
    return (
        <div className={styles.root}>
            <CatalogViewer />
            <div className={styles.overlay_container}>
                <div className={styles.overlay_header_container}>
                    Schema
                </div>
                {overlayScriptEntries.length > 0 && (
                    <div className={styles.overlay_body_container}>
                        <div className={styles.overlay_body_list}>
                            {overlayScriptEntries}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
