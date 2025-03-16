import * as zstd from "../../../../node_modules/@bokuweb/zstd-wasm/dist/esm/index.web.js";

const ZSTD_WASM = new URL("../../../../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm", import.meta.url);

let CALLED_INIT = false;

export async function init(): Promise<void> {
    if (CALLED_INIT) {
        return;
    }
    await zstd.init(ZSTD_WASM.toString());
    CALLED_INIT = true;
}

export const compress = zstd.compress;
export const decompress = zstd.decompress;
