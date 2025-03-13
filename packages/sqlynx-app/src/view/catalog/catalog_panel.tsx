import { ContextObjectID } from '@ankoh/sqlynx-core';

import * as sqlynx from '@ankoh/sqlynx-core';
import * as React from 'react';
import * as styles from './catalog_panel.module.css';

import { CatalogViewer } from '../catalog/catalog_viewer.js';
import { FOCUSED_COMPLETION, FOCUSED_EXPRESSION_ID, FOCUSED_TABLE_REF_ID } from '../../workbook/focus.js';
import { useCurrentWorkbookState } from '../../workbook/current_workbook.js';
import { U32_MAX } from '../../utils/numeric_limits.js';
import { useConnectionState } from '../../connection/connection_registry.js';
import { CatalogUpdateTaskState, CatalogUpdateTaskStatus } from '../../connection/catalog_update_state.js';
import { CatalogRefreshView } from './catalog_refresh_view.js';
import { CatalogInfoView } from './catalog_info_view.js';

interface CatalogPanelProps { }

export function CatalogPanel(_props: CatalogPanelProps) {
    const [workbookState, _dispatchWorkbook] = useCurrentWorkbookState();
    const [connState, _connDispatch] = useConnectionState(workbookState?.connectionId ?? null);

    const workbookEntry = workbookState?.workbookEntries[workbookState.selectedWorkbookEntry];
    const script = workbookEntry ? workbookState.scripts[workbookEntry.scriptKey] : null;

    // Collect overlay metrics
    const infoEntries = React.useMemo<[string, string][]>(() => {
        const overlay: [string, string][] = [];

        // Inspect the cursor
        const cursor = script?.cursor;
        if (cursor && cursor.scannerSymbolId != U32_MAX) {
            const scanned = script.processed.scanned?.read();
            const tokens = scanned?.tokens();
            const tokenTypes = tokens?.tokenTypesArray();
            if (tokenTypes && cursor.scannerSymbolId < tokenTypes.length) {
                const tokenType = tokenTypes[cursor.scannerSymbolId];
                const tokenTypeName = sqlynx.getScannerTokenTypeName(tokenType);

                overlay.push([
                    "Token",
                    tokenTypeName
                ]);
            }
        }

        // Is there a user focus?
        const focusTarget = workbookState?.userFocus?.focusTarget;
        switch (focusTarget?.type) {
            case FOCUSED_TABLE_REF_ID: {
                const tableRefObject = focusTarget.value.tableReference;
                const scriptKey = ContextObjectID.getContext(tableRefObject);
                const tableRefId = ContextObjectID.getObject(tableRefObject);
                const scriptData = workbookState?.scripts[scriptKey];
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
                const scriptData = workbookState?.scripts[scriptKey];
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
    }, [workbookState?.userFocus, script?.cursor]);

    // Resolve the latest full-refresh task
    const fullRefreshTask = React.useMemo<CatalogUpdateTaskState | null>(() => {
        const lastFullRefresh = connState?.catalogUpdates.lastFullRefresh ?? null;
        if (lastFullRefresh != null) {
            const task = connState!.catalogUpdates.tasksRunning.get(lastFullRefresh)
                ?? connState!.catalogUpdates.tasksFinished.get(lastFullRefresh)
                ?? null;
            return task;
        }
        return null;
    }, [connState?.catalogUpdates]);

    // Show the catalog full refresh status until the latest refresh succeeded
    const showRefreshView = fullRefreshTask != null
        && fullRefreshTask.status != CatalogUpdateTaskStatus.SUCCEEDED;

    return (
        <div className={styles.root}>
            <div className={styles.panel_container}>
                <div className={styles.catalog_viewer}>
                    <CatalogViewer />
                    {showRefreshView
                        ? (
                            <div className={styles.info_overlay}>
                                <CatalogRefreshView conn={connState!} refresh={fullRefreshTask} />
                            </div>
                        )
                        : (
                            <div className={styles.info_overlay}>
                                <CatalogInfoView conn={connState!} entries={infoEntries} />
                            </div>
                        )
                    }

                </div>
            </div>
        </div>
    );
}
