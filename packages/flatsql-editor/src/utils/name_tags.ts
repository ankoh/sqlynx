import * as flatsql from '@ankoh/flatsql';

export function unpackNameTags(tags: bigint): flatsql.proto.NameTag[] {
    const out = [];
    for (const tag of [
        flatsql.proto.NameTag.KEYWORD,
        flatsql.proto.NameTag.SCHEMA_NAME,
        flatsql.proto.NameTag.DATABASE_NAME,
        flatsql.proto.NameTag.TABLE_NAME,
        flatsql.proto.NameTag.TABLE_ALIAS,
        flatsql.proto.NameTag.COLUMN_NAME,
    ]) {
        if ((tags & BigInt(tag)) != BigInt(0)) {
            out.push(Number(tag) as flatsql.proto.NameTag);
        }
    }
    return out;
}

export function getNameTagName(tag: flatsql.proto.NameTag): string {
    switch (tag) {
        case flatsql.proto.NameTag.KEYWORD:
            return 'keyword';
        case flatsql.proto.NameTag.SCHEMA_NAME:
            return 'schema';
        case flatsql.proto.NameTag.DATABASE_NAME:
            return 'database';
        case flatsql.proto.NameTag.TABLE_NAME:
            return 'table';
        case flatsql.proto.NameTag.TABLE_ALIAS:
            return 'table alias';
        case flatsql.proto.NameTag.COLUMN_NAME:
            return 'column';
        default:
            return '';
    }
}
