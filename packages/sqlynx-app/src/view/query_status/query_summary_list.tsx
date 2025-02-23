import * as React from "react";
import * as styles from "./query_summaries.module.css";

import { QueryExecutionState } from "../../connection/query_execution_state.js";
import { QueryExecutionSummary } from "./query_summary.js";

interface QueryExecutionSummariesProps {
    conn: number;
    queries: number[];
}

export function QueryExecutionSummaryList(props: QueryExecutionSummariesProps) {
    return (
        <div>
            {props.queries.map((q, i) => <QueryExecutionSummary key={i} conn={props.conn} query={q} />)}
        </div>
    );
}
