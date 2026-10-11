import * as buffers from './buffers.js';

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

export function findClosestToken(hl: buffers.parser.ScannerTokens, pos: number): number | null {
    const offsets = hl.tokenOffsetsArray();
    if ((offsets?.length ?? 0) === 0) {
        return null;
    } else {
        let rightIdx = lowerBound(offsets!, pos, 0, offsets!.length);
        let leftIdx = rightIdx > 0 ? (rightIdx - 1) : rightIdx;
        const right = offsets![rightIdx];
        const left = offsets![leftIdx]
        if (Math.abs(right - pos) < Math.abs(left - pos)) {
            return rightIdx;
        } else {
            return leftIdx;
        }
    }
}

export function findTokensInRange(hl: buffers.parser.ScannerTokens, begin: number, end: number): [number, number] {
    const offsets = hl.tokenOffsetsArray();
    if ((offsets?.length ?? 0) === 0) {
        return [0, 0];
    }
    let lb = lowerBound(offsets!, begin, 0, offsets!.length);
    lb = offsets![lb] > begin && lb > 0 ? lb - 1 : lb;
    const ub = lowerBound(offsets!, end, lb, offsets!.length);
    return [lb, ub];
}

export function resolveSymbolSpan(
    tokens: buffers.parser.ScannerTokens,
    span: buffers.parser.SymbolSpan,
): { offset: number; length: number } {
    if (span.length() === 0) {
        if (span.offset() >= tokens.tokenOffsetsLength()) {
            return { offset: 0, length: 0 };
        }
        return { offset: tokens.tokenOffsets(span.offset()) ?? 0, length: 0 };
    }
    const first = span.offset();
    const last = first + span.length() - 1;
    const begin = tokens.tokenOffsets(first) ?? 0;
    const lastOffset = tokens.tokenOffsets(last) ?? 0;
    const lastLen = tokens.tokenLengths(last) ?? 0;
    const end = lastOffset + lastLen;
    return { offset: begin, length: end - begin };
}

export function findTokensAtTextSpan(
    hl: buffers.parser.ScannerTokens,
    offset: number,
    length: number,
): [number, number] {
    if (!hl || hl.tokenOffsetsLength() === 0) return [0, 0];
    const begin = offset;
    const end = offset + length;
    const [lb, ub] = findTokensInRange(hl, begin, end);
    return [lb, ub];
}

export function getScannerTokenTypeName(token: buffers.parser.ScannerTokenType) {
    switch (token) {
        case buffers.parser.ScannerTokenType.NONE:
            return "none";
        case buffers.parser.ScannerTokenType.KEYWORD:
            return "keyword";
        case buffers.parser.ScannerTokenType.KEYWORD_VIS:
            return "keyword(vis)";
        case buffers.parser.ScannerTokenType.LITERAL_BINARY:
            return "literal(binary)";
        case buffers.parser.ScannerTokenType.LITERAL_BOOLEAN:
            return "literal(boolean)";
        case buffers.parser.ScannerTokenType.LITERAL_FLOAT:
            return "literal(float)";
        case buffers.parser.ScannerTokenType.LITERAL_HEX:
            return "literal(hex)";
        case buffers.parser.ScannerTokenType.LITERAL_INTEGER:
            return "literal(integer)";
        case buffers.parser.ScannerTokenType.LITERAL_STRING:
            return "literal(string)";
        case buffers.parser.ScannerTokenType.OPERATOR:
            return "operator";
        case buffers.parser.ScannerTokenType.IDENTIFIER:
            return "identifier";
        case buffers.parser.ScannerTokenType.COMMENT:
            return "comment";
        case buffers.parser.ScannerTokenType.DOT:
            return "dot";
        case buffers.parser.ScannerTokenType.DOT_TRAILING:
            return "dot(trailing)";
        default:
            return "?";
    }

}
