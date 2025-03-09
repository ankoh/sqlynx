import * as arrow from 'apache-arrow';

import { QueryExecutionArgs } from "../query_execution_args.js";
import { DemoConnectionParams } from "./demo_connection_state.js";
import { QueryExecutionResponseStream, QueryType } from "../query_execution_state.js";
import { DemoQuerySpec } from './demo_database_channel.js';
import { Int128 } from '../../utils/int128.js';

const DEFAULT_QUERY_FIRST_EVENT = Math.floor((new Date()).getTime() - 1000 * 60 * 60 * 24 * 10);
const DEFAULT_QUERY_SPEC: DemoQuerySpec = {
    fields: [
        {
            name: "Text/Random",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => crypto.randomUUID()
        },
        {
            name: "Text/10",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => `LongRandomText/${Math.floor(Math.random() * 10)}`
        },
        {
            name: "Text/2",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => `BinaryText/${Math.floor(Math.random() * 2)}`
        },
        {
            name: "Text/2/Nulls",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => Math.random() < 0.3 ? null : `NullableText/${Math.floor(Math.random() * 2)}`
        },
        {
            name: "EventTime",
            type: new arrow.TimestampMillisecond(),
            nullable: true,
            generateScalarValue: (row: number) => BigInt(DEFAULT_QUERY_FIRST_EVENT + Math.floor(row * 1000 * 60 * 60 + Math.random() * 1000 * 60 * 60))
        },
        {
            name: "Score1",
            type: new arrow.Decimal(18, 38, 128),
            nullable: true,
            generateScalarValue: (row: number) => {
                const intPart = BigInt(row) * BigInt(1e18);
                const fractionPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e14);
                return Int128.encodeLE(intPart + fractionPart);
            }
        },
        {
            name: "Score2",
            type: new arrow.Decimal(18, 38, 128),
            nullable: true,
            generateScalarValue: (_row: number) => {
                if (Math.random() < 0.2) {
                    return null;
                } else {
                    const intPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e18);
                    const fractionPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e14);
                    return Int128.encodeLE(intPart + fractionPart);
                }
            }
        },
        {
            name: "Score3",
            type: new arrow.Decimal(18, 38, 128),
            nullable: false,
            generateScalarValue: (_row: number) => {
                const intPart = BigInt(Math.floor(Math.random() * 1e4)) * BigInt(1e18);
                return Int128.encodeLE(intPart);
            }
        },
        {
            name: "Float32",
            type: new arrow.Float32(),
            nullable: false,
            generateScalarValue: (_row: number) => {
                const value = Math.random();
                return value;
            }
        },
        {
            name: "List/Float32",
            type: new arrow.List(new arrow.Field(
                "element",
                new arrow.Float32(),
                false
            )),
            nullable: false,
            listElement: {
                name: "List/Float32/Element",
                type: new arrow.Float32(),
                nullable: false,
                generateScalarValue: (_row: number) => {
                    const value = Math.random();
                    return value;
                }
            },
            listLength: (_row: number) => 1024,
        },
    ],
    resultBatches: 3,
    resultRowsPerBatch: 200,
    timeMsUntilFirstBatch: 500,
    timeMsBetweenBatches: 50,
};

const CATALOG_SCHEMAS = 10;
const CATALOG_TABLES_PER_SCHEMA = 10;
const CATALOG_COLUMNS_PER_TABLE = 10;
const CATALOG_COLUMNS_PER_SCHEMA = CATALOG_COLUMNS_PER_TABLE * CATALOG_TABLES_PER_SCHEMA;

const CATALOG_QUERY_SPEC: DemoQuerySpec = {
    fields: [
        {
            name: "table_catalog",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => "sqlynx"
        },
        {
            name: "table_schema",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (_row: number) => `public`
        },
        {
            name: "table_name",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (row: number) => `table_${Math.floor(row / CATALOG_COLUMNS_PER_SCHEMA)}_${Math.floor(row / CATALOG_COLUMNS_PER_TABLE)}`
        },
        {
            name: "column_name",
            type: new arrow.Utf8(),
            nullable: true,
            generateScalarValue: (row: number) => `column_${Math.floor(row / CATALOG_COLUMNS_PER_SCHEMA)}_${Math.floor(row / CATALOG_COLUMNS_PER_TABLE)}_${row % CATALOG_COLUMNS_PER_TABLE}`
        },
        {
            name: "ordinal_position",
            type: new arrow.Uint32(),
            nullable: true,
            generateScalarValue: (row: number) => row % CATALOG_COLUMNS_PER_TABLE
        },
        {
            name: "is_nullable",
            type: new arrow.Uint32(),
            nullable: true,
            generateScalarValue: (_row: number) => true
        },
        {
            name: "data_type",
            type: new arrow.Uint32(),
            nullable: true,
            generateScalarValue: (_row: number) => `varchar`
        },
    ],
    resultBatches: CATALOG_SCHEMAS,
    resultRowsPerBatch: CATALOG_COLUMNS_PER_SCHEMA * CATALOG_SCHEMAS,
    timeMsUntilFirstBatch: 500,
    timeMsBetweenBatches: 50,
}

export async function executeDemoQuery(conn: DemoConnectionParams, args: QueryExecutionArgs, abort?: AbortSignal): Promise<QueryExecutionResponseStream> {
    if (!conn.channel) {
        throw new Error(`demo channel is not set up`);
    }

    let spec = DEFAULT_QUERY_SPEC;
    if (args.metadata.queryType == QueryType.CATALOG_QUERY_INFORMATION_SCHEMA) {
        spec = CATALOG_QUERY_SPEC;
    }
    return await conn.channel.executeQuery(spec, abort);
}
