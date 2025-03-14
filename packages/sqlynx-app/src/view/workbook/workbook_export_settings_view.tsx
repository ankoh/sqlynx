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

    const toggleCatalog = React.useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        props.setSettings({ ...props.settings, exportCatalog: !props.settings.exportCatalog });
    }, [props.settings, props.setSettings]);

    const toggleUsername = React.useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        props.setSettings({ ...props.settings, exportUsername: !props.settings.exportUsername });
    }, [props.settings, props.setSettings]);

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
                        onClick={toggleCatalog}
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
                        checked={props.settings.exportUsername}
                        onClick={toggleUsername}
                    />
                </div>
            </div>
        </div>
    );
};
