import * as dashql from '@ankoh/dashql-core';

export function unpackNameTags(tags: number): dashql.proto.NameTag[] {
    const out = [];
    for (const tag of [
        dashql.proto.NameTag.SCHEMA_NAME,
        dashql.proto.NameTag.DATABASE_NAME,
        dashql.proto.NameTag.TABLE_NAME,
        dashql.proto.NameTag.TABLE_ALIAS,
        dashql.proto.NameTag.COLUMN_NAME,
    ]) {
        if ((tags & tag) != 0) {
            out.push(Number(tag) as dashql.proto.NameTag);
        }
    }
    return out;
}

export function getNameTagName(tag: dashql.proto.NameTag): string {
    switch (tag) {
        case dashql.proto.NameTag.SCHEMA_NAME:
            return 'schema';
        case dashql.proto.NameTag.DATABASE_NAME:
            return 'database';
        case dashql.proto.NameTag.TABLE_NAME:
            return 'table';
        case dashql.proto.NameTag.TABLE_ALIAS:
            return 'query_result alias';
        case dashql.proto.NameTag.COLUMN_NAME:
            return 'column';
        default:
            return '';
    }
}
