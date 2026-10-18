import * as arrow from 'apache-arrow';
import * as React from 'react';

import * as ActionList from '../../../../../ui/foundations/action_list.js';
import * as styles from './query_result_download_button.module.css';
import { QueryExecutionStatus, type QueryExecutionState } from '../../../connections/query_execution_state.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../../../ui/foundations/button.js';
import { useFocusTrap } from '../../../../../ui/foundations/focus.js';
import { Overlay, OverlaySize } from '../../../../../ui/foundations/overlay.js';
import { DownloadIcon, SymbolIcon, TableIcon, XIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { useFileDownloader } from '../../../../../platform/file/file_downloader_provider.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../../platform/logger/logger.js';
import { AtlasExportForm, atlasSqlFields } from './atlas_export_form.js';

const ColumnsIcon = SymbolIcon('columns_16');

interface Props {
    query: QueryExecutionState;
    dependencies?: {
        useFileDownloader: () => Pick<ReturnType<typeof useFileDownloader>, 'downloadBufferAsFile'>;
        useLogger: () => Pick<ReturnType<typeof useLogger>, 'error'>;
    };
}

export function QueryResultDownloadButton({ query, dependencies = { useFileDownloader, useLogger } }: Props) {
    const fileDownloader = dependencies.useFileDownloader();
    const logger = dependencies.useLogger();
    const [dialogOpen, setDialogOpen] = React.useState(false);
    const [downloading, setDownloading] = React.useState(false);
    const resultTable = query.status === QueryExecutionStatus.SUCCEEDED ? query.resultTable : null;

    const downloadResult = async () => {
        setDialogOpen(false);
        if (resultTable == null || downloading) return;
        setDownloading(true);
        try {
            const bytes = arrow.tableToIPC(resultTable, 'file');
            await fileDownloader.downloadBufferAsFile(bytes, `query-result-${query.queryId}.arrow`);
        } catch (error) {
            logger.error('Failed to download query result', { error: stringifyError(error) }, 'query_result_download');
        } finally {
            setDownloading(false);
        }
    };

    return (
        <>
            <IconButton
                variant={ButtonVariant.Invisible}
                size={ButtonSize.Small}
                aria-label="Download query result"
                onClick={() => setDialogOpen(true)}
                disabled={resultTable == null || downloading}
            >
                <DownloadIcon size={16} />
            </IconButton>
            {dialogOpen && resultTable != null && (
                <DownloadDialog
                    table={resultTable}
                    onCancel={() => setDialogOpen(false)}
                    onDownloadArrow={() => void downloadResult()}
                />
            )}
        </>
    );
}

interface DownloadDialogProps {
    table: arrow.Table;
    onCancel: () => void;
    onDownloadArrow: () => void;
}

/// Choose what to download, the result as Arrow file or a column of SQL texts as Atlas folder
function DownloadDialog(props: DownloadDialogProps) {
    const headingId = React.useId();
    const dialogRef = React.useRef<HTMLElement>(null);
    const [atlas, setAtlas] = React.useState(false);
    // The dialog stays open while the Atlas export writes its files
    const [busy, setBusy] = React.useState(false);
    const close = () => { if (!busy) props.onCancel(); };
    const hasSqlFields = React.useMemo(() => atlasSqlFields(props.table).length > 0, [props.table]);
    useFocusTrap({
        containerRef: dialogRef as React.RefObject<HTMLElement>,
        initialFocusRef: dialogRef as React.RefObject<HTMLElement>,
        restoreFocusOnCleanUp: true,
    });

    return (
        <Overlay
            centered
            width={OverlaySize.L}
            preventFocusOnOpen
            onEscape={close}
            onClickOutside={close}
        >
            {/* Clicks in the portal still bubble through the React tree of the button */}
            <section
                ref={dialogRef}
                className={styles.dialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby={headingId}
                tabIndex={-1}
                onClick={e => e.stopPropagation()}
            >
                <header className={styles.header}>
                    <h2 id={headingId}>{atlas ? 'Atlas Export' : 'Download'}</h2>
                    <IconButton
                        variant={ButtonVariant.Invisible}
                        aria-label="Close download"
                        onClick={close}
                        disabled={busy}
                    >
                        <XIcon />
                    </IconButton>
                </header>
                {!atlas ? <ActionList.List aria-label="Download type" leading>
                    <ActionList.ListItem onClick={props.onDownloadArrow}>
                        <ActionList.Leading><TableIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>Result as Arrow</ActionList.ItemText>
                    </ActionList.ListItem>
                    <ActionList.ListItem onClick={() => setAtlas(true)} disabled={!hasSqlFields}>
                        <ActionList.Leading><ColumnsIcon size={16} /></ActionList.Leading>
                        <ActionList.ItemText>SQL Column as Atlas</ActionList.ItemText>
                    </ActionList.ListItem>
                </ActionList.List> : <AtlasExportForm table={props.table} onCancel={close} onBusy={setBusy} />}
            </section>
        </Overlay>
    );
}
