import * as React from "react";
import * as styles from './connection_info_view.module.css';

import { useConnectionState } from "../../connection/connection_registry.js";


interface ConnectionInfoViewProps {
    /// The connection id
    conn: number;
}

export function ConnectionInfoView(props: ConnectionInfoViewProps) {
    const [conn, _] = useConnectionState(props.conn);


    if (!conn) {
        return <div />;
    }
    return (
        <div className={styles.root}>
            <div className={styles.title}>
                {conn.connectorInfo.displayName.long}
            </div>
        </div>
    );
}
