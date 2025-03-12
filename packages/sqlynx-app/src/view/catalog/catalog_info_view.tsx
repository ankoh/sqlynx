import * as React from "react";
import * as styles from "./catalog_info_view.module.css";

import { ConnectionState } from "../../connection/connection_state.js";

interface CatalogInfoViewProps {
    conn: ConnectionState;
}

export function CatalogInfoView(props: CatalogInfoViewProps) {
    return (
        <div className={styles.root}>
            <div className={styles.header}>
                Foo
            </div>
        </div>
    );
}
