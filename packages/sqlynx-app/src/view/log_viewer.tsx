import * as React from 'react';
import * as state from '../state';
import * as utils from '../utils';
import classNames from 'classnames';
import { SystemCard } from './system_card';
import { withCurrentTime } from '../utils/current_time';
import { observeSize } from './size_observer';
import { motion, AnimatePresence } from 'framer-motion';
import { FixedSizeList, FixedSizeListProps, ListChildComponentProps } from 'react-window';

import styles from './log_viewer.module.css';

const OVERSCAN_ROW_COUNT = 5;

interface Props {
    className?: string;
    currentTime: Date;
    updateCurrentTime: () => void;
    onClose: () => void;
}

export const LogViewer: React.FC<Props> = (props: Props) => {
    const [focused, setFocused] = React.useState<number | null>(null);
    const log = state.useLogState();

    React.useEffect(() => props.updateCurrentTime(), [log.entries]);

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        let nextEntry = focused || 0;
        switch (event.key) {
            case 'Down':
            case 'ArrowDown':
                nextEntry = Math.min(nextEntry + 1, Math.max(log.entries.size - 1, 0));
                break;
            case 'Up':
            case 'ArrowUp':
                nextEntry = Math.max(nextEntry, 1) - 1;
                break;
        }
        event.preventDefault();
        event.stopPropagation();
        setFocused(nextEntry);
    };

    const focusEntry = (elem: React.MouseEvent<HTMLDivElement>) => {
        const entry = (elem.currentTarget as any).dataset.entry;
        setFocused((focused != entry ? parseInt(entry) : null) ?? null);
    };

    const LogEntry = (childProps: ListChildComponentProps<number>) => {
        const logEntryIndex = childProps.index;
        const logEntry = log.entries.get(logEntryIndex);
        if (!logEntry) return <div style={childProps.style} />;
        const tsNow = props.currentTime;
        const tsLog = logEntry.timestamp;
        return (
            <div
                key={logEntryIndex}
                style={childProps.style}
                className={styles.row_container}
                data-entry={logEntryIndex}
                onClick={focusEntry}
            >
                <div className={classNames(styles.row, { [styles.row_focused]: logEntryIndex == focused })}>
                    <div className={styles.row_level}>{state.getLogLevelLabel(logEntry.level)}</div>
                    <div className={styles.row_origin}>{state.getLogOriginLabel(logEntry.origin)}</div>
                    <div className={styles.row_topic}>{state.getLogTopicLabel(logEntry.topic)}</div>
                    <div className={styles.row_event}>{state.getLogEventLabel(logEntry.event)}</div>
                    <div className={styles.row_timestamp}>{utils.getRelativeTime(tsLog, tsNow)}</div>
                </div>
            </div>
        );
    };

    const containerElement = React.useRef(null);
    const containerSize = observeSize(containerElement);
    return (
        <SystemCard title="Log" onClose={props.onClose} className={props.className}>
            <div className={styles.content} onKeyDown={onKeyDown}>
                {focused != null && (
                    <AnimatePresence>
                        <motion.div
                            className={styles.detail_container}
                            initial={{ height: 0 }}
                            animate={{ height: 100 }}
                            exit={{ height: 0 }}
                        >
                            {log.entries.get(focused)?.value.toString()}
                        </motion.div>
                    </AnimatePresence>
                )}
                <div ref={containerElement} className={styles.list_container}>
                    {containerSize && (
                        <FixedSizeList
                            className={styles.list}
                            width={containerSize.width || 150}
                            height={containerSize.height || 100}
                            overscanCount={OVERSCAN_ROW_COUNT}
                            itemCount={log.entries.size}
                            itemSize={32}
                        >
                            {LogEntry}
                        </FixedSizeList>
                    )}
                </div>
            </div>
        </SystemCard>
    );
};

export const RefreshingLogViewer = withCurrentTime(LogViewer, 5000);
