import * as arrow from 'apache-arrow';


export function isTemporalType(typeId: arrow.Type): boolean {
    switch (typeId) {
        case arrow.Type.Date:
        case arrow.Type.DateDay:
        case arrow.Type.DateMillisecond:
        case arrow.Type.Time:
        case arrow.Type.TimeSecond:
        case arrow.Type.TimeMillisecond:
        case arrow.Type.TimeMicrosecond:
        case arrow.Type.TimeNanosecond:
        case arrow.Type.Timestamp:
        case arrow.Type.TimestampSecond:
        case arrow.Type.TimestampMillisecond:
        case arrow.Type.TimestampMicrosecond:
        case arrow.Type.TimestampNanosecond:
        case arrow.Type.DurationSecond:
        case arrow.Type.DurationMillisecond:
        case arrow.Type.DurationMicrosecond:
        case arrow.Type.DurationNanosecond:
            return true;
        default:
            return false;
    }
}

export function getToNumericFn(typeId: arrow.Type): string | undefined {
    if (isTemporalType(typeId)) {
        return "EPOCH";
    }
    return typeId === arrow.Type.Bool ? "BOOLEAN" : undefined;
}

export function isIntegerType(typeId: arrow.Type): boolean {
    switch (typeId) {
        case arrow.Type.Int:
        case arrow.Type.Int8:
        case arrow.Type.Int16:
        case arrow.Type.Int32:
        case arrow.Type.Int64:
        case arrow.Type.Uint8:
        case arrow.Type.Uint16:
        case arrow.Type.Uint32:
        case arrow.Type.Uint64:
            return true;
        default:
            return false;
    }
}

export function getSmallIntegerDomainSize(minValue: unknown, maxValue: unknown, maxSize: number): number | null {
    if (typeof minValue === 'bigint' && typeof maxValue === 'bigint') {
        const size = maxValue - minValue + 1n;
        return size > 0n && size <= BigInt(maxSize) ? Number(size) : null;
    }
    if (typeof minValue === 'number' && typeof maxValue === 'number' && Number.isInteger(minValue) && Number.isInteger(maxValue)) {
        const size = maxValue - minValue + 1;
        return size > 0 && size <= maxSize ? size : null;
    }
    return null;
}

export function createUniqueColumnName(prefix: string, fieldNames: Set<string>) {
    let name = prefix;
    while (true) {
        if (fieldNames.has(name)) {
            name = `_${name}`;
        } else {
            fieldNames.add(name);
            return name;
        }
    }
}
