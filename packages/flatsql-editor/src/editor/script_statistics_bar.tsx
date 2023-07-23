import * as flatsql from '@ankoh/flatsql';

import React from 'react';
import Immutable from 'immutable';

import { formatBytes, formatNanoseconds } from '../utils/format';

import styles from './script_statistics_bar.module.css';

interface HistoryProps {
    data: Float64Array;
    maximum: number;
}

const History: React.FC<HistoryProps> = (props: HistoryProps) => {
    const out = [];
    const scaledMax = props.maximum * 1.2;
    for (let i = 0; i < props.data.length; ++i) {
        const percent = (props.data[i] * 100) / scaledMax;
        out.push(
            <div
                key={i}
                style={{
                    height: `${percent}%`,
                    backgroundColor: 'var(--stats_bg)',
                }}
            />,
        );
    }
    return <div className={styles.metric_history}>{out}</div>;
};

interface Props {
    className?: string;
    stats: Immutable.List<flatsql.FlatBufferRef<flatsql.proto.ScriptStatistics>>;
}

export const ScriptStatisticsBar: React.FC<Props> = (props: Props) => {
    if (props.stats.isEmpty()) {
        return <div className={props.className}></div>;
    }

    const protoStats = new flatsql.proto.ScriptStatistics();
    const protoTimings = new flatsql.proto.ScriptProcessingTimings();
    const protoMemory = new flatsql.proto.ScriptMemoryStatistics();
    const protoProcessingMemory = new flatsql.proto.ScriptProcessingMemoryStatistics();

    const computeTotalElapsed = (timings: flatsql.proto.ScriptProcessingTimings) =>
        timings.scannerLastElapsed() + timings.parserLastElapsed() + timings.analyzerLastElapsed();
    const sumProcessingMemory = (mem: flatsql.proto.ScriptProcessingMemoryStatistics) =>
        mem.scannerInputBytes() + mem.scannerDictionaryBytes() + mem.parserAstBytes() + mem.analyzerBytes();
    const computeTotalMemory = (mem: flatsql.proto.ScriptMemoryStatistics) => {
        let total = mem.ropeBytes() + mem.completionIndexBytes();
        total += sumProcessingMemory(mem.latestScript(protoProcessingMemory)!);
        total += sumProcessingMemory(mem.coolingScript(protoProcessingMemory)!);
        total += sumProcessingMemory(mem.stableScript(protoProcessingMemory)!);
        return total;
    };

    const last = props.stats.last()!.read(protoStats)!;
    const lastTotalElapsed = computeTotalElapsed(last.timings(protoTimings)!);
    const lastTotalMemory = computeTotalMemory(last.memory(protoMemory)!);

    const elapsedHistory = new Float64Array(Math.max(Math.min(props.stats.size, 20), 20));
    const memoryHistory = new Float64Array(Math.max(Math.min(props.stats.size, 20), 20));
    let maxTotalElapsed = 0;
    let maxTotalMemory = 0;
    let writer = 0;
    for (const reading of props.stats) {
        const stats = reading.read(protoStats)!;
        const totalElapsed = computeTotalElapsed(stats.timings(protoTimings)!);
        const totalMemory = computeTotalMemory(stats.memory(protoMemory)!);
        elapsedHistory[writer] = totalElapsed;
        memoryHistory[writer] = totalMemory;
        maxTotalElapsed = Math.max(maxTotalElapsed, totalElapsed);
        maxTotalMemory = Math.max(maxTotalMemory, totalMemory);
        ++writer;
    }

    return (
        <div className={styles.container}>
            <div className={styles.metric_container}>
                <History data={elapsedHistory} maximum={maxTotalElapsed} />
                <div className={styles.metric_last_reading}>{formatNanoseconds(lastTotalElapsed)}</div>
            </div>
            <div className={styles.metric_container}>
                <History data={memoryHistory} maximum={maxTotalMemory} />
                <div className={styles.metric_last_reading}>{formatBytes(lastTotalMemory)}</div>
            </div>
        </div>
    );
};
