export const RESULT_OK = Symbol('RESULT_OK');
export const RESULT_ERROR = Symbol('RESULT_ERROR');

export type Result<ValueType> =
    | { type: typeof RESULT_OK; value: ValueType }
    | { type: typeof RESULT_ERROR; error: Error };
