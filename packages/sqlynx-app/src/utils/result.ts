export const RESULT_OK = Symbol();
export const RESULT_ERROR = Symbol();

export type Result<ValueType> =
    | { type: typeof RESULT_OK; value: ValueType }
    | { type: typeof RESULT_ERROR; error: Error };
