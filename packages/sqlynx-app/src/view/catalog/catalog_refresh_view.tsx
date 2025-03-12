import * as React from "react";
import * as styles from "./catalog_refresh_view.module.css";

import { ConnectionState } from "../../connection/connection_state.js";
import { CATALOG_UPDATE_TASK_STATUS_NAMES, CatalogUpdateTaskState } from "../../connection/catalog_update_state.js";
import { QueryInfoListView } from "../query_status/query_info_list_view.js";

interface CatalogRefreshViewProps {
    conn: ConnectionState;
    refresh: CatalogUpdateTaskState;
}

export function CatalogRefreshView(props: CatalogRefreshViewProps) {
    return (
        <div className={styles.root}>
            <div className={styles.header}>
                {CATALOG_UPDATE_TASK_STATUS_NAMES[props.refresh.status]}
            </div>
            <div>
                <QueryInfoListView conn={props.conn.connectionId} connQueries={props.refresh?.queries ?? []} />
            </div>
        </div>
    );
}
