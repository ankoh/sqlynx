import { DASHQL_BUILD_MODE } from "../globals.js";

export function assert(condition: boolean, message?: string) {
    if (DASHQL_BUILD_MODE == 'development') {
        console.assert(condition, message);
    }
}
