import * as React from 'react';
import * as styles from './trace_log_panel.module.css';

import { LogRecord } from '../../../platform/logger/log_buffer.js';
import { useLogger } from '../../../platform/logger/logger_provider.js';
import { TraceLogViewer } from './trace_log_viewer.js';

/// Track the number of log records on a trace, updating as records stream in. Returns 0 when the
/// trace has no id. Drives the right-aligned "N of M rows" indicator.
function useTraceLogCount(traceId: number | null): number {
    const logger = useLogger();
    const [count, setCount] = React.useState(0);
    React.useEffect(() => {
        if (traceId == null) {
            setCount(0);
            return;
        }
        setCount(logger.buffer.collectTraceLogs(traceId).length);
        const observer = (_record: LogRecord) => setCount(prev => prev + 1);
        logger.buffer.subscribeTrace(traceId, observer);
        return () => logger.buffer.unsubscribeTrace(traceId, observer);
    }, [traceId, logger]);
    return count;
}

interface TraceLogPanelProps {
    traceId: number | null;
    title: string;
    /// Scrollless preview mode: the viewer auto-expands to fit its rows and caps at this many. Used
    /// by the feed server card. When unset the viewer fills its parent's height and scrolls.
    maxRows?: number;
    /// When set, the header opens the corresponding Details log tab.
    onHeaderClick?: () => void;
}

/// One trace-log surface. Independent logs use separate vertical tabs, so this component no
/// longer owns source selection; it only renders the selected trace and its row count.
export const TraceLogPanel: React.FC<TraceLogPanelProps> = (props) => {
    const totalLogRows = useTraceLogCount(props.traceId);
    const shownLogRows = props.maxRows != null ? Math.min(totalLogRows, props.maxRows) : totalLogRows;
    const logCountDetail = (props.maxRows != null && totalLogRows > props.maxRows)
        ? `${shownLogRows} of ${totalLogRows} rows`
        : `${totalLogRows} ${totalLogRows === 1 ? 'row' : 'rows'}`;

    return (
        <>
            <div className={styles.log_header}>
                {props.onHeaderClick != null ? (
                    <button type="button" className={styles.log_header_target} onClick={props.onHeaderClick}>
                        <span className={styles.log_header_title}>{props.title}</span>
                    </button>
                ) : (
                    <span className={styles.log_header_title}>{props.title}</span>
                )}
                <span className={styles.log_header_detail}>{logCountDetail}</span>
            </div>
            {props.traceId == null ? (
                <div className={styles.log_empty}>No logs available</div>
            ) : props.maxRows != null ? (
                <TraceLogViewer traceId={props.traceId ?? undefined} maxRows={props.maxRows} />
            ) : (
                <div className={styles.log_viewer_fill}>
                    <TraceLogViewer traceId={props.traceId ?? undefined} fill />
                </div>
            )}
        </>
    );
};
