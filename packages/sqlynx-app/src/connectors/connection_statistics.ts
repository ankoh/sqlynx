export interface ConnectionStatistics {
    totalQueriesStarted: bigint;
    totalQueriesFinished: bigint;
    totalQueryDurationMs: bigint;
    lastQueryStarted: Date | null;
    lastQueryFinished: Date | null;
}

export function createConnectionStatistics(): ConnectionStatistics {
    return {
        totalQueriesStarted: BigInt(0),
        totalQueriesFinished: BigInt(0),
        totalQueryDurationMs: BigInt(0),
        lastQueryStarted: null,
        lastQueryFinished: null
    };
}
