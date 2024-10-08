import SQLynxCompute from '@ankoh/sqlynx-compute';

const WASM_URL = new URL('@ankoh/sqlynx-compute/pkg/sqlynx_compute_bg.wasm', import.meta.url);

SQLynxCompute(WASM_URL);
