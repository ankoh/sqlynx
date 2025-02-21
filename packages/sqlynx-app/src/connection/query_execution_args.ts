import { QueryMetadata } from "./query_execution_state.js";

/// The query executor args
export interface QueryExecutionArgs {
    query: string;
    analyzeResults?: boolean;

    metadata: QueryMetadata;
}
