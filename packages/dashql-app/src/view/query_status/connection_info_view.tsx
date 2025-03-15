import * as React from "react";
import * as styles from './connection_info_view.module.css';

import { useConnectionState } from "../../connection/connection_registry.js";
import { classNames } from "../../utils/classnames.js";


interface ConnectionInfoViewProps {
    /// The styles
    style?: React.CSSProperties;
    /// The class name
    className?: string;
    /// The connection id
    conn: number;
}

export function ConnectionInfoView(props: ConnectionInfoViewProps) {
    const [conn, _] = useConnectionState(props.conn);


    if (!conn) {
        return <div />;
    }
    return (
        <div className={classNames(props.className, styles.root)} style={props.style}>
            <div className={styles.title}>
                {conn.connectorInfo.displayName.long}
            </div>
        </div>
    );
}
