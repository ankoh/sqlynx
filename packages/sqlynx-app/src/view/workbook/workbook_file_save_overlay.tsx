import * as React from 'react';
import * as styles from './workbook_file_save_overlay.module.css';

import { Box, IconButton } from '@primer/react';
import { DownloadIcon, FileIcon } from '@primer/octicons-react';

import { AnchorAlignment } from '../foundations/anchored_position.js';
import { AnchoredOverlay } from '../foundations/anchored_overlay.js';
import { ConnectionState } from '../../connection/connection_state.js';
import { WorkbookExportSettings } from '../../workbook/workbook_export_settings.js';
import { WorkbookExportSettingsView } from './workbook_export_settings_view.js';
import { WorkbookState } from '../../workbook/workbook_state.js';
import { classNames } from '../../utils/classnames.js';
import { encodeWorkbookAsFile } from '../../workbook/workbook_export_file.js';
import { formatBytes } from '../../utils/format.js';

interface Props {
    className?: string;
    isOpen: boolean;
    setIsOpen: (v: boolean) => void;
    workbook: WorkbookState | null;
    conn: ConnectionState | null;
}

export const WorkbookFileSaveOverlay: React.FC<Props> = (props: Props) => {
    const anchorRef = React.createRef<HTMLDivElement>();
    const buttonRef = React.createRef<HTMLAnchorElement>();

    const [settings, setSettings] = React.useState<WorkbookExportSettings>({
        exportCatalog: true,
        exportUsername: true
    });

    const [fileBytes, setFileBytes] = React.useState<Uint8Array>(new Uint8Array());
    React.useEffect(() => {
        if (props.conn == null || props.workbook == null) {
            return;
        }
        const file = encodeWorkbookAsFile(props.workbook, props.conn, settings);
        const fileBytes = file.toBinary();
        setFileBytes(fileBytes);
    }, [settings, props.conn, props.workbook]);

    return (
        <AnchoredOverlay
            renderAnchor={() => <div ref={anchorRef} />}
            open={props.isOpen}
            onClose={() => props.setIsOpen(false)}
            anchorRef={anchorRef}
            align={AnchorAlignment.End}
            overlayProps={{
                initialFocusRef: buttonRef,
            }}
        >
            <Box className={classNames(styles.overlay, props.className)}>
                <div className={styles.header}>
                    <div className={styles.file_icon_container}>
                        <FileIcon />
                    </div>
                    <div className={styles.file_info}>
                        <div className={styles.file_name}>workbook.slnx</div>
                        <div className={styles.file_size}>~&nbsp;{formatBytes(fileBytes.length)}</div>
                    </div>
                    <div className={styles.download}>
                        <IconButton
                            ref={buttonRef}
                            icon={DownloadIcon}
                            aria-labelledby="save-file"
                        />
                    </div>
                </div>
                <WorkbookExportSettingsView
                    withCatalog={true}
                    settings={settings}
                    setSettings={setSettings}
                />
            </Box>
        </AnchoredOverlay>
    );
};
