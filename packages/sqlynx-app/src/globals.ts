// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_BUILD_MODE: string = process.env.SQLYNX_BUILD_MODE!;
// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_VERSION: string = process.env.SQLYNX_VERSION!;
// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_GIT_COMMIT: string = process.env.SQLYNX_GIT_COMMIT!;

// The URL of the git repository
export const SQLYNX_GIT_REPO: URL = new URL(`https://github.com/ankoh/sqlynx/tree/${SQLYNX_GIT_COMMIT}`);
/// The URL of the stable release manifest
export const SQLYNX_STABLE_RELEASE_MANIFEST = new URL("https://get.sqlynx.app/stable.json");
/// The URL of the canary release manifest
export const SQLYNX_CANARY_RELEASE_MANIFEST = new URL("https://get.sqlynx.app/canary.json");


export function isDebugBuild() {
    return SQLYNX_BUILD_MODE == "development";
}
