import type * as arrow from 'apache-arrow';

import { Logger } from '../platform/logger/logger.js';
import type {
    EmbeddedComputeDatabase,
    EmbeddedTableImportConnection,
} from '../platform/database/embedded_database.js';

const LOG_CTX = "data_frame";

let nextTableId = 0;

export function generateTableName(prefix: string = "__df"): string {
    return `${prefix}_${nextTableId++}`;
}

export class DataFrame {
    readonly database: EmbeddedComputeDatabase;
    readonly tableName: string;

    constructor(database: EmbeddedComputeDatabase, tableName: string) {
        this.database = database;
        this.tableName = tableName;
    }

    static async withConnection<T>(database: EmbeddedComputeDatabase, fn: (conn: EmbeddedTableImportConnection) => Promise<T>): Promise<T> {
        const conn = await database.connect({ pooled: true });
        try {
            return await fn(conn);
        } finally {
            await conn.close();
        }
    }

    async withConnection<T>(fn: (conn: EmbeddedTableImportConnection) => Promise<T>): Promise<T> {
        return await DataFrame.withConnection(this.database, fn);
    }

    static async fromArrowTable(database: EmbeddedComputeDatabase, table: arrow.Table, tableName: string): Promise<DataFrame> {
        await DataFrame.withConnection(database, async conn => {
            await conn.insertArrowTable(table, { name: tableName, create: true });
        });
        return new DataFrame(database, tableName);
    }

    static async fromSQL(database: EmbeddedComputeDatabase, sql: string, tableName: string, abort?: AbortSignal): Promise<DataFrame> {
        await DataFrame.withConnection(database, async conn => {
            await conn.createTableAs(tableName, sql, abort);
        });
        return new DataFrame(database, tableName);
    }

    async readTable(abort?: AbortSignal): Promise<arrow.Table> {
        return await this.withConnection(async conn => await conn.query(`SELECT * FROM "${this.tableName}"`, abort));
    }

    async destroy(): Promise<void> {
        await this.withConnection(async conn => await conn.execute(`DROP TABLE IF EXISTS "${this.tableName}"`));
    }
}

export class DataFrameRegistry {
    logger: Logger;
    registeredDataFrames: Map<DataFrame, number> = new Map();

    constructor(logger: Logger) {
        this.logger = logger;
    }

    public getRegisteredDataFrames() {
        return this.registeredDataFrames;
    }

    acquire(dataFrame: DataFrame | null | undefined, times: number = 1) {
        if (dataFrame == undefined || dataFrame == null) {
            return;
        }
        if (this.registeredDataFrames.has(dataFrame)) {
            this.registeredDataFrames.set(dataFrame, this.registeredDataFrames.get(dataFrame)! + times);
        } else {
            this.registeredDataFrames.set(dataFrame, times);
        }
    }

    release(dataFrame?: DataFrame | null) {
        if (dataFrame == undefined || dataFrame == null) {
            return;
        }
        if (this.registeredDataFrames.has(dataFrame)) {
            const count = this.registeredDataFrames.get(dataFrame)! - 1;
            if (count <= 0) {
                this.registeredDataFrames.delete(dataFrame);
                void dataFrame.destroy().catch(error => {
                    this.logger.warn("Failed to destroy released data frame", {
                        "tableName": dataFrame.tableName,
                        "error": error instanceof Error ? error.message : String(error),
                    }, LOG_CTX);
                });
            } else {
                this.registeredDataFrames.set(dataFrame, count);
            }
        } else {
            this.logger.warn("Attempted to release unknown data frame", {
                "tableName": dataFrame.tableName
            }, LOG_CTX);
        }
    }

    releaseMany(dataFrames: (DataFrame | null | undefined)[]) {
        for (const dataFrame of dataFrames) {
            this.release(dataFrame);
        }
    }
}
