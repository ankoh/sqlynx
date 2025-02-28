// XXX No longer needed

export interface SortedElement {
    sortKey: number;
}

export function lowerBound<T extends SortedElement>(values: T[], key: number): number {
    let begin = 0;
    let end = values.length;
    while (begin < end) {
        const m: number = begin + ((end - begin) >> 1);
        const midRef = values[m].sortKey;
        if (midRef < key) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return begin;
}

export function insertSorted<T extends SortedElement>(values: T[], value: T) {
    let index = lowerBound(values, value.sortKey);
    if (index < values.length) {
        if (values[index].sortKey != value.sortKey) {
            values.splice(index, 0, value);
        }
    } else {
        values.push(value);
    }
}

export function removeSorted<T extends SortedElement>(values: T[], value: T) {
    let index = lowerBound(values, value.sortKey);
    if (index >= values.length) {
        return;
    } else if (values[index].sortKey == value.sortKey) {
        values.splice(index, 1);
    }
}

export function binarySearch<T extends SortedElement>(values: T[], key: number): null | [T, number] {
    const iter = lowerBound(values, key);
    if (iter == values.length || values[iter].sortKey != key) {
        return null;
    } else {
        return [values[iter], iter];
    }
}

export function lowerBoundU32(values: Uint32Array, value: number): number {
    let begin = 0;
    let end = values.length;
    while (begin < end) {
        const m: number = begin + ((end - begin) >> 1);
        const midRef = values[m];
        if (midRef < value) {
            begin = m + 1;
        } else {
            end = m;
        }
    }
    return begin;
}
