import * as arrow from 'apache-arrow';
import * as React from 'react';
import * as styles from './query_result_download_button.module.css';

import { QueryExecutionStatus, type QueryExecutionState } from '../../../../../query/query_execution_state.js';
import { ButtonSize, ButtonVariant, IconButton } from '../../../../../ui/foundations/button.js';
import * as ActionList from '../../../../../ui/foundations/action_list.js';
import { AnchorAlignment, AnchorSide } from '../../../../../ui/foundations/anchored_position.js';
import { AnchoredOverlay } from '../../../../../ui/foundations/anchored_overlay.js';
import { DownloadIcon } from '../../../../../ui/foundations/symbol_icon.js';
import { useComputeDatabase } from '../../../../../compute/compute_connection_provider.js';
import { exportArrowTableAsParquet, supportsParquetExport } from '../../../../../platform/hyperdb/hyperdb_parquet_export.js';
import { useFileDownloader } from '../../../../../platform/file/file_downloader_hook.js';
import { useLogger } from '../../../../../platform/logger/logger_provider.js';
import { stringifyError } from '../../../../../platform/logger/logger.js';

const enum DownloadFormat {
    Arrow = 'arrow',
    Parquet = 'parquet',
}

interface Props {
    query: QueryExecutionState;
    dependencies?: {
        useFileDownloader: () => Pick<ReturnType<typeof useFileDownloader>, 'downloadBufferAsFile'>;
        useLogger: () => Pick<ReturnType<typeof useLogger>, 'error'>;
        useComputeDatabase: typeof useComputeDatabase;
        exportArrowTableAsParquet: typeof exportArrowTableAsParquet;
    };
}

const DEFAULT_DEPENDENCIES: NonNullable<Props['dependencies']> = {
    useFileDownloader,
    useLogger,
    useComputeDatabase,
    exportArrowTableAsParquet,
};

export function QueryResultDownloadButton({ query, dependencies = DEFAULT_DEPENDENCIES }: Props) {
    const fileDownloader = dependencies.useFileDownloader();
    const logger = dependencies.useLogger();
    const computeDatabase = dependencies.useComputeDatabase();
    const parquetDatabase = supportsParquetExport(computeDatabase) ? computeDatabase : null;
    const [open, setOpen] = React.useState(false);
    const [downloading, setDownloading] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const hasResult = query.status === QueryExecutionStatus.SUCCEEDED && query.resultTable != null;

    const downloadResult = async (format: DownloadFormat) => {
        setOpen(false);
        if (!hasResult || downloading) return;
        setDownloading(true);
        try {
            switch (format) {
                case DownloadFormat.Arrow: {
                    const bytes = arrow.tableToIPC(query.resultTable!, 'file');
                    await fileDownloader.downloadBufferAsFile(bytes, `query-result-${query.queryId}.arrow`);
                    break;
                }
                case DownloadFormat.Parquet: {
                    if (parquetDatabase == null) throw new Error('compute database cannot export Parquet');
                    const bytes = await dependencies.exportArrowTableAsParquet(parquetDatabase, query.resultTable!);
                    await fileDownloader.downloadBufferAsFile(bytes, `query-result-${query.queryId}.parquet`);
                    break;
                }
            }
        } catch (error) {
            logger.error('Failed to download query result', { format, error: stringifyError(error) }, 'query_result_download');
        } finally {
            setDownloading(false);
        }
    };

    return (
        <AnchoredOverlay
            open={open}
            onOpen={() => setOpen(true)}
            onClose={() => setOpen(false)}
            side={AnchorSide.OutsideBottom}
            align={AnchorAlignment.End}
            anchorOffset={4}
            anchorRef={triggerRef}
            returnFocusRef={triggerRef}
            renderAnchor={(anchorProps) => (
                <IconButton
                    {...anchorProps}
                    ref={triggerRef}
                    variant={ButtonVariant.Invisible}
                    size={ButtonSize.Small}
                    aria-label="Download query result"
                    disabled={!hasResult || downloading}
                >
                    <DownloadIcon size={16} />
                </IconButton>
            )}
        >
            <div className={styles.menu} role="dialog" aria-label="Download query result">
                <ActionList.List aria-label="Download formats">
                    <ActionList.ListItem onClick={() => downloadResult(DownloadFormat.Arrow)}>
                        <ActionList.ItemText>Download as Arrow</ActionList.ItemText>
                    </ActionList.ListItem>
                    <ActionList.ListItem
                        disabled={parquetDatabase == null}
                        onClick={() => downloadResult(DownloadFormat.Parquet)}
                    >
                        <ActionList.ItemText>Download as Parquet</ActionList.ItemText>
                    </ActionList.ListItem>
                </ActionList.List>
            </div>
        </AnchoredOverlay>
    );
}
