import * as React from 'react';

import {
    getQueryTarget,
    QueryHistoryViewer,
    type QueryEntry,
} from '../../../../query/ui/query_history_viewer.js';
import { QueryType } from '../../../../query/query_execution_state.js';
import { useAttachedDatabaseRegistry } from '../attached_database_registry.js';

export * from '../../../../query/ui/query_history_viewer.js';

export function QueryViewer(props: {
    onClose: () => void;
}) {
    const [connReg] = useAttachedDatabaseRegistry();
    const entries = React.useMemo(() => {
        const next: QueryEntry[] = [];
        for (const [connectionId, conn] of connReg.attachedDatabases) {
            const connectorName = conn.connectorInfo.names.displayShort;
            for (const queryIds of [conn.queriesFinishedOrdered, conn.queriesActiveOrdered]) {
                for (const queryId of queryIds) {
                    const query = conn.queriesActive.get(queryId) ?? conn.queriesFinished.get(queryId);
                    if (query == null) continue;
                    const sourceName = query.queryMetadata.queryType == QueryType.INTERNAL_SQLFRAME
                        ? 'SQLFrame'
                        : connectorName;
                    next.push({
                        connectionId,
                        sourceName,
                        target: getQueryTarget(query),
                        queryId,
                        query,
                    });
                }
            }
        }
        return next;
    }, [connReg]);

    return <QueryHistoryViewer entries={entries} onClose={props.onClose} />;
}
