import { SQLYNX_BUILD_MODE } from "../globals.js";

export function assert(condition: boolean, message?: string) {
    if (SQLYNX_BUILD_MODE == 'development') {
        console.assert(condition, message);
    }
}
