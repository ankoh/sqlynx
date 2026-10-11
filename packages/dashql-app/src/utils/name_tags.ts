import * as dashql from '@ankoh/dashql-core';

export function unpackNameTags(tags: number): dashql.buffers.analyzer.NameTag[] {
    const out = [];
    for (const tag of [
        dashql.buffers.analyzer.NameTag.SCHEMA_NAME,
        dashql.buffers.analyzer.NameTag.DATABASE_NAME,
        dashql.buffers.analyzer.NameTag.TABLE_NAME,
        dashql.buffers.analyzer.NameTag.TABLE_ALIAS,
        dashql.buffers.analyzer.NameTag.COLUMN_NAME,
    ]) {
        if ((tags & tag) != 0) {
            out.push(Number(tag) as dashql.buffers.analyzer.NameTag);
        }
    }
    return out;
}

export function getNameTagName(tag: dashql.buffers.analyzer.NameTag): string {
    switch (tag) {
        case dashql.buffers.analyzer.NameTag.SCHEMA_NAME:
            return 'schema';
        case dashql.buffers.analyzer.NameTag.DATABASE_NAME:
            return 'database';
        case dashql.buffers.analyzer.NameTag.TABLE_NAME:
            return 'table';
        case dashql.buffers.analyzer.NameTag.TABLE_ALIAS:
            return 'query_result alias';
        case dashql.buffers.analyzer.NameTag.COLUMN_NAME:
            return 'column';
        default:
            return '';
    }
}
