import * as dashql from '@ankoh/dashql-core';

export function unpackNameTags(tags: number): dashql.buffers.NameTag[] {
    const out = [];
    for (const tag of [
        dashql.buffers.NameTag.SCHEMA_NAME,
        dashql.buffers.NameTag.DATABASE_NAME,
        dashql.buffers.NameTag.TABLE_NAME,
        dashql.buffers.NameTag.TABLE_ALIAS,
        dashql.buffers.NameTag.COLUMN_NAME,
    ]) {
        if ((tags & tag) != 0) {
            out.push(Number(tag) as dashql.buffers.NameTag);
        }
    }
    return out;
}

export function getNameTagName(tag: dashql.buffers.NameTag): string {
    switch (tag) {
        case dashql.buffers.NameTag.SCHEMA_NAME:
            return 'schema';
        case dashql.buffers.NameTag.DATABASE_NAME:
            return 'database';
        case dashql.buffers.NameTag.TABLE_NAME:
            return 'table';
        case dashql.buffers.NameTag.TABLE_ALIAS:
            return 'query_result alias';
        case dashql.buffers.NameTag.COLUMN_NAME:
            return 'column';
        default:
            return '';
    }
}
