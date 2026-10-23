import * as arrow from 'apache-arrow';

import { AsyncConsumerLambdas } from '../../utils/async_consumer.js';
import type { TracedLogger } from '../../platform/logger/logger.js';
import type { QueryExecutionProgress, QueryExecutionResponseStream } from '../../query/query_execution_state.js';
import * as buf from '@bufbuild/protobuf';
import * as proto from '../../proto.js';
import { HYPER_CONNECTOR, SALESFORCE_DATA_CLOUD_CONNECTOR, TRINO_CONNECTOR } from './connector_info.js';
import type { ConnectionStateDetailsVariant } from './connection_state_details.js';
import type { QueryExecutionArgs } from './query_execution_args.js';

/// The channel of a connection, a channel override wins while the connection is set up
function requireChannel<T>(channel: T | null, connector: string): T {
    if (channel == null) {
        throw new Error(`${connector} channel is not set up`);
    }
    return channel;
}

/// Execute a query on the channel of a connection
export function executeConnectionQuery(
    details: ConnectionStateDetailsVariant,
    args: QueryExecutionArgs,
    abort?: AbortSignal,
): Promise<QueryExecutionResponseStream> {
    const param = buf.create(proto.salesforce_hyperdb_grpc_v1.pb.QueryParamSchema, { query: args.query });
    const override = args.channelOverride;
    switch (details.type) {
        case SALESFORCE_DATA_CLOUD_CONNECTOR:
            return requireChannel(override?.type === 'salesforce' ? override.channel : details.value.channel, 'Salesforce').executeQuery(param, abort);
        case HYPER_CONNECTOR:
            return requireChannel(override?.type === 'hyper' ? override.channel : details.value.channel, 'Hyper').executeQuery(param, abort, { readTimeoutMs: args.readTimeoutMs });
        case TRINO_CONNECTOR:
            return requireChannel(override?.type === 'trino' ? override.channel : details.value.channel, 'Trino').executeQuery(param, abort);
    }
}

interface ConsumeQueryResponseStreamArgs {
    stream: QueryExecutionResponseStream;
    abort?: AbortSignal;
    publishResults: boolean;
    onProgress: (progress: QueryExecutionProgress) => void;
    onBatch?: (batch: arrow.RecordBatch, stream: QueryExecutionResponseStream) => void;
    onResultsReceived?: () => void;
    logger?: TracedLogger;
    logContext?: {
        sessionId: string;
        queryId: number;
        target: string;
    };
}

export async function consumeQueryResponseStream(args: ConsumeQueryResponseStreamArgs): Promise<arrow.Table | null> {
    const batches: arrow.RecordBatch[] = [];
    const consumeProgress = new AsyncConsumerLambdas<QueryExecutionResponseStream, QueryExecutionProgress>(
        (_stream, progress) => args.onProgress(progress),
    );
    const consumeBatches = new AsyncConsumerLambdas<QueryExecutionResponseStream, arrow.RecordBatch>(
        (stream, batch) => {
            if (!args.publishResults) return;
            batches.push(batch);
            if (args.logger && args.logContext) {
                args.logger.debug("Received result batch", {
                    sessionId: args.logContext.sessionId,
                    query: args.logContext.queryId.toString(),
                    batchColumns: batch.numCols.toString(),
                    batchRows: batch.numRows.toString(),
                }, args.logContext.target);
            }
            args.onBatch?.(batch, stream);
        },
    );

    await args.stream.produce(consumeBatches, consumeProgress, args.abort);
    args.onResultsReceived?.();
    if (!args.publishResults) return null;

    const schema = batches.length > 0
        ? batches[0].schema
        : await args.stream.getSchema() ?? new arrow.Schema();
    return new arrow.Table(schema, batches);
}
