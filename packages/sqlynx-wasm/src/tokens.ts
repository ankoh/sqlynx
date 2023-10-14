import * as proto from '../gen/sqlynx/proto';

interface Indexable<ValueType> {
    [index: number]: ValueType;
}

function lowerBound<ValueType, ArrayType extends Indexable<ValueType>>(
    values: ArrayType,
    target: ValueType,
    begin: number,
    end: number,
): number {
    let count = end - begin;
    while (count > 0) {
        const step = count >>> 1;
        const it = begin + step;
        if (values[it] < target) {
            begin = it + 1;
            count -= step + 1;
        } else {
            count = step;
        }
    }
    return begin;
}

export function findTokensInRange(hl: proto.ScannerTokens, begin: number, end: number) {
    const offsets = hl.tokenOffsetsArray();
    if ((offsets?.length ?? 0) === 0) {
        return [0, 0];
    }
    let lb = lowerBound(offsets!, begin, 0, offsets!.length);
    lb = offsets![lb] > begin && lb > 0 ? lb - 1 : lb;
    const ub = lowerBound(offsets!, end, lb, offsets!.length);
    return [lb, ub];
}
