/// Helper to remove a single element from an array
export function removePrimitiveFromArray<T>(arr: Array<T>, value: T): Array<T> {
    const index = arr.indexOf(value);
    if (index !== -1) {
        arr.splice(index, 1);
    }
    return arr;
}
