import * as React from "react";
import * as styles from "./catalog_refresh_view.module.css";

import { ConnectionState } from "../../connection/connection_state.js";
import { CatalogUpdateTaskState } from "../../connection/catalog_update_state.js";
import { QueryExecutionState } from "../../connection/query_execution_state.js";
import { QueryExecutionSummaryList } from "../query_status/query_summary_list.js";

interface CatalogRefreshViewProps {
    conn: ConnectionState;
    refresh: CatalogUpdateTaskState;
}

export function CatalogRefreshView(props: CatalogRefreshViewProps) {
    return (
        <div className={styles.root}>
            <div>{props.refresh.status}</div>
            <div>
                <QueryExecutionSummaryList conn={props.conn.connectionId} queries={props.refresh?.queries ?? []} />
            </div>
        </div>
    );
}
