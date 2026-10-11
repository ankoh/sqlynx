import * as buffers from './buffers.js';

export function formatQualifiedTableName(q: buffers.analyzer.QualifiedTableName): string {
    const schema = q.schemaName();
    const table = q.tableName();
    if (!table) return '';
    if (schema) return `${schema}.${table}`;
    return table;
}

export function formatQualifiedColumnName(q: buffers.analyzer.QualifiedColumnName): string {
    const alias = q.tableAlias();
    const col = q.columnName();
    if (!col) return '';
    if (alias) return `${alias}.${col}`;
    return col;
}

export function formatQualifiedFunctionName(q: buffers.analyzer.QualifiedFunctionName): string {
    const schema = q.schemaName();
    const fn = q.functionName();
    if (!fn) return '';
    if (schema) return `${schema}.${fn}`;
    return fn;
}
