import { DashQL, type DashQLModuleOptions } from '@ankoh/dashql-core';

declare global {
    var DASHQL_PRECOMPILED: Promise<Uint8Array> | undefined;
    var __DASHQL_TEST_CORE_WASM_MODULE__: Promise<WebAssembly.Module> | undefined;
    var __DASHQL_TEST_DASHBOARD_CORE_INSTANCE__: Promise<DashQL> | undefined;
    var __DASHQL_TEST_CORE_CREATIONS__: number | undefined;
    var __DASHQL_TEST_CORE_FACTORY__: ((options?: DashQLModuleOptions) => Promise<DashQL>) | undefined;
    var __DASHQL_TEST_RESET_CORE_INSTANCE__: (() => void) | undefined;
}

export async function createPrecompiledTestCore(bytes: Promise<Uint8Array>): Promise<DashQL> {
    globalThis.__DASHQL_TEST_CORE_WASM_MODULE__ ??= bytes.then(binary => WebAssembly.compile(binary.slice().buffer));
    const module = await globalThis.__DASHQL_TEST_CORE_WASM_MODULE__;
    return DashQL.create({
        instantiateWasm: async (imports, success) => {
            const instance = await WebAssembly.instantiate(module, imports);
            success(instance, module);
            return instance.exports;
        },
    });
}

export function installSharedCoreTestPool(): void {
    const create = DashQL.create.bind(DashQL);
    let shared: Promise<DashQL> | undefined;
    // This override exists only in the test iframe, never in a production entry point.
    DashQL.create = async (options?: DashQLModuleOptions) => {
        shared ??= globalThis.__DASHQL_TEST_CORE_FACTORY__?.(options) ?? create(options);
        const instance = await shared;
        globalThis.__DASHQL_TEST_RESET_CORE_INSTANCE__ = () => instance.resetUnsafe();
        return instance;
    };
}
