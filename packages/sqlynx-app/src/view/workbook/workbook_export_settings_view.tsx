import * as React from 'react';

import { ToggleSwitch } from '@primer/react';

import * as styles from './workbook_export_settings_view.module.css';
import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';

interface Props {
    withCatalog: boolean;
    settings: WorkbookExportSettings;
    setSettings: (s: WorkbookExportSettings) => void;
}

export const WorkbookExportSettingsView: React.FC<Props> = (props: Props) => {
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
                    <ToggleSwitch
                        size="small"
                        checked={props.settings.exportCatalog}
                        disabled={!props.withCatalog}
                        onChange={(b: boolean) => props.setSettings({ ...props.settings, exportCatalog: b })}
                    />
                </div>
            </div>
            <div className={styles.part_list}>
                <div className={styles.part_name}>
                    Trino Username
                </div>
                <div className={styles.part_toggle}>
                    <ToggleSwitch
                        size="small"
                        checked={true}
                        onChange={(b: boolean) => props.setSettings({ ...props.settings, exportUsername: b })}
                    />
                </div>
            </div>
        </div>
    );
};
