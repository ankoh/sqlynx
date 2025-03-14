import * as React from 'react';

import { ToggleSwitch } from '@primer/react';

import * as styles from './workbook_export_settings.module.css';

interface Props {
    enableCatalog: boolean;
}

export const WorkbookExportSettings: React.FC<Props> = (props: Props) => {
    const [catalog, _setCatalog] = React.useState<boolean>(true && props.enableCatalog);

    return (
        <div className={styles.root}>
            <div className={styles.part_list}>
                <div className={styles.part_name}>
                    Connection Settings
                </div>
                <div className={styles.part_toggle}>
                    <ToggleSwitch size="small" checked={true} disabled={true} />
                </div>
                <div className={styles.part_name}>
                    Workbook Data
                </div>
                <div className={styles.part_toggle}>
                    <ToggleSwitch size="small" checked={true} disabled={true} />
                </div>
                <div className={styles.part_name}>
                    Catalog Data
                </div>
                <div className={styles.part_toggle}>
                    <ToggleSwitch size="small" checked={catalog} disabled={!props.enableCatalog} />
                </div>
            </div>
            <div className={styles.part_list}>
                <div className={styles.part_name}>
                    Trino Username
                </div>
                <div className={styles.part_toggle}>
                    <ToggleSwitch size="small" checked={true} />
                </div>
            </div>
        </div>
    );
};
