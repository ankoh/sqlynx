import * as zstd from "../../../../node_modules/@bokuweb/zstd-wasm/dist/esm/index.web.js";

const ZSTD_WASM = new URL("../../../../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm", import.meta.url);

export async function init(): Promise<void> {
    await zstd.init(ZSTD_WASM.toString());
}

export const compress = zstd.compress;
export const decompress = zstd.decompress;
