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
        const overlayEntries: [string, string][] = [];

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
                    overlayEntries.push([
                        "Reference Type",
                        tableRef.innerType().toString(),
                    ]);
                    const location = tableRef.location();
                    if (location != null) {
                        overlayEntries.push([
                            "Location",
                            `${location.offset()}:+${location.length()}`
                        ]);
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
                    overlayEntries.push([
                        "Expression Type",
                        expression.innerType().toString(),
                    ]);
                }
                break;
            }
            case FOCUSED_COMPLETION:
                overlayEntries.push([
                    "Type",
                    "Completion",
                ]);
                break;
        }

        // Otherwise inspect the cursor
        if (overlayEntries.length == 0) {
            const cursor = sessionState?.scripts[ScriptKey.MAIN_SCRIPT].cursor;
            if (cursor && cursor.scannerSymbolId != U32_MAX) {
                const scanned = sessionState?.scripts[ScriptKey.MAIN_SCRIPT].processed.scanned?.read();
                const tokens = scanned?.tokens();
                if (tokens) {
                    const tokenOffsets = tokens.tokenOffsetsArray()!;
                    // const tokenLengths = tokens.tokenLengthsArray()!;
                    // const tokenTypes = tokens.tokenTypesArray()!;

                    const tokenOffset = tokenOffsets[cursor.scannerSymbolId];
                    // const tokenLength = tokenLengths[cursor.scannerSymbolId];
                    // const tokenType = tokenTypes[cursor.scannerSymbolId];

                    overlayEntries.push([
                        "Token Offset",
                        `${tokenOffset}`
                    ]);
                }
            }
        }

        return overlayEntries;
    }, [sessionState?.userFocus]);

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
