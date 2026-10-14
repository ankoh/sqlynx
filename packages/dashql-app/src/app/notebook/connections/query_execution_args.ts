import { UmapRequest } from "../../../compute/umap/umap_projection.js";
import { HyperDatabaseChannel } from "./hyper/hyperdb_grpc_client.js";
import { QueryMetadata } from "./query_execution_state.js";
import { SalesforceDatabaseChannel } from "./salesforce/salesforce_api_client.js";
import { TrinoChannelInterface } from "./trino/trino_channel.js";
import type { DashQLScriptExecution } from '@ankoh/dashql-core';

/// The query executor args
export interface QueryExecutionArgs {
    query: string;
    /// Core-owned execution workflow for a multi-statement notebook script.
    scriptExecution?: DashQLScriptExecution;
    /// Optional caller-owned cancellation signal. The executor links this to its
    /// own query cancellation controller without taking ownership of it.
    abortSignal?: AbortSignal;
    /// Maximum time to wait for the next native gRPC result batch.
    readTimeoutMs?: number;
    analyzeResults?: boolean;
    /// Drain statements without materializing a result when the planner discards their output.
    publishResults?: boolean;
    /// Receives trace-scoped query execution log messages as they are emitted. Intended for
    /// transient progress surfaces such as the notebook shell.
    onLog?: (message: string) => void;
    /// Reports labeled query lifecycle timings before the complete execution promise resolves.
    onTiming?: (label: string, elapsedMs: number) => void;
    /// Called once after the backend result is fully consumed, but before optional result analysis.
    /// The normal execution promise still resolves only after postprocessing completes.
    onResultsReady?: () => void;
    /// Computation from the previous execution of the same notebook entry. It can be retired before
    /// analyzing this result so its temporary embedded-database tables do not accumulate across reruns.
    replaceComputationId?: number | null;
    metadata: QueryMetadata;
    /// When true, the executor consults the file-based query result cache: it serves a matching
    /// cached `.arrow` result instead of hitting the backend, and stores the result after a miss.
    /// Only user-provided queries should set this; catalog/health-check queries leave it unset so
    /// they never touch the cache. Cache failures are always non-fatal (fall back to execution).
    cacheable?: boolean;
    /// Versioned semantic AST signature for the complete script. Required for cacheable notebook
    /// queries so preceding statements affect identity without making formatting or comments do so.
    cacheSignature?: string;
    /// Reject the execution promise with the original connector error after recording the failed
    /// query state. Most notebook callers use the historical null-on-failure behavior; hosts such
    /// as the shell need the error text to complete their asynchronous effect.
    throwOnError?: boolean;
    /// Optional UMAP projection request. When present (a resolved `'umap'` visualize
    /// spec), the result post-processing step computes per-row 2D coordinates, appends
    /// them to the analyzed table, and records their field names on the embedding
    /// column's group. Requires `analyzeResults`.
    projection?: UmapRequest;
    /// Optional channel to run the query on. When present, the executor uses this
    /// channel instead of reading one from the AttachedDatabaseState. Callers need this
    /// when they hold the channel locally but haven't waited for the React state
    /// update that publishes it into the connection map (e.g. right after a
    /// connection setup resolves).
    channelOverride?: QueryExecutionChannelOverride;
}

export type QueryExecutionChannelOverride =
    | { type: 'hyper'; channel: HyperDatabaseChannel }
    | { type: 'salesforce'; channel: SalesforceDatabaseChannel }
    | { type: 'trino'; channel: TrinoChannelInterface };
