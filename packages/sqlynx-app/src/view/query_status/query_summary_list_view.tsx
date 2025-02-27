import * as React from "react";

import { QueryExecutionSummaryView } from "./query_summary_view.js";

interface QueryExecutionSummariesProps {
    conn: number;
    queries: number[];
}

export function QueryExecutionSummaryList(props: QueryExecutionSummariesProps) {
    return (
        <div>
            {props.queries.map((q, i) => <QueryExecutionSummaryView key={i} conn={props.conn} query={q} />)}
        </div>
    );
}
