// Injected through the DefinePlugin in webpack.common.ts
export const DASHQL_BUILD_MODE: string = process.env.DASHQL_BUILD_MODE!;
// Injected through the DefinePlugin in webpack.common.ts
export const DASHQL_VERSION: string = process.env.DASHQL_VERSION!;
// Injected through the DefinePlugin in webpack.common.ts
export const DASHQL_GIT_COMMIT: string = process.env.DASHQL_GIT_COMMIT!;
// Injected through the DefinePlugin in webpack.common.ts
export const DASHQL_LOG_LEVEL: string = process.env.DASHQL_LOG_LEVEL!;

// The URL of the git repository
export const DASHQL_GIT_REPO: URL = new URL(`https://github.com/ankoh/dashql/tree/${DASHQL_GIT_COMMIT}`);
/// The URL of the stable release manifest
export const DASHQL_STABLE_RELEASE_MANIFEST = new URL("https://get.dashql.app/stable.json");
/// The URL of the canary release manifest
export const DASHQL_CANARY_RELEASE_MANIFEST = new URL("https://get.dashql.app/canary.json");

export function isDebugBuild() {
    return DASHQL_BUILD_MODE == "development";
}
