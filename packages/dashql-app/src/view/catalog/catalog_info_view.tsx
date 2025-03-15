import * as React from "react";
import * as styles from "./catalog_info_view.module.css";

import { ConnectionState } from "../../connection/connection_state.js";
import { formatTimeDifference } from "../../utils/format.js";

interface CatalogInfoViewProps {
    conn: ConnectionState;
    entries: [string, string][];
}

interface CatalogStats {
    dbCount: number;
    schemaCount: number;
    tableCount: number;
    columnCount: number;
}

const UI_REFRESH_INTERVAL = 5000;

export function CatalogInfoView(props: CatalogInfoViewProps) {
    const snap = props.conn.catalog.createSnapshot();

    const catalogStats = React.useMemo(() => {
        const snapReader = snap.read();

        const dbCount = snapReader.catalogReader.databasesLength();
        const schemaCount = snapReader.catalogReader.schemasLength();
        const tableCount = snapReader.catalogReader.tablesLength();
        const columnCount = snapReader.catalogReader.columnsLength();
        const stats: CatalogStats = {
            dbCount,
            schemaCount,
            tableCount,
            columnCount
        };

        return stats;

    }, [snap]);

    const [refreshUi, setRefreshUi] = React.useState<number>(1);
    React.useEffect(() => {
        const timeoutId = setTimeout(() => setRefreshUi(s => s + 1), UI_REFRESH_INTERVAL);
        return () => clearTimeout(timeoutId);
    }, [refreshUi]);

    const lastFullRefresh = props.conn.catalogUpdates.lastFullRefresh
    const sinceLastFullRefresh = React.useMemo(() => {
        let sinceLastFullRefresh = null;
        if (lastFullRefresh != null) {
            const task = props.conn!.catalogUpdates.tasksRunning.get(lastFullRefresh)
                ?? props.conn!.catalogUpdates.tasksFinished.get(lastFullRefresh)
                ?? null;
            if (task?.startedAt != null) {
                sinceLastFullRefresh = formatTimeDifference(task.startedAt);
            }
        }
        return sinceLastFullRefresh;
    }, [refreshUi]);

    const Metric = (props: { name: string, value: string }) => (
        <>
            <div className={styles.catalog_metric_key}>
                {props.name}
            </div>
            <div className={styles.catalog_metric_value}>
                {props.value}
            </div>
        </>
    );
    const AdditionalEntry = (props: { name: string, value: string }) => (
        <>
            <div className={styles.additional_entry_key}>
                {props.name}
            </div>
            <div className={styles.additional_entry_value}>
                {props.value}
            </div>
        </>
    );

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                Catalog
            </div>
            <div className={styles.catalog_metrics}>
                <Metric name="Last Refresh" value={sinceLastFullRefresh ?? "-"} />
                <Metric name="Databases" value={Intl.NumberFormat().format(catalogStats.dbCount)} />
                <Metric name="Schemas" value={Intl.NumberFormat().format(catalogStats.schemaCount)} />
                <Metric name="Tables" value={Intl.NumberFormat().format(catalogStats.tableCount)} />
                <Metric name="Columns" value={Intl.NumberFormat().format(catalogStats.columnCount)} />
            </div>
            {props.entries.length > 0 &&
                <div className={styles.additional_entries}>
                    {props.entries.map(([n, v], i) => (
                        <AdditionalEntry key={i} name={n} value={v} />
                    ))}
                </div>
            }
        </div>
    );
}
