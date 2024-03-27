// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_BUILD_MODE: string = process.env.SQLYNX_BUILD_MODE!;
// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_VERSION: string = process.env.SQLYNX_VERSION!;
// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_GIT_COMMIT: string = process.env.SQLYNX_GIT_COMMIT!;

// The URL of the release channel at get.sqlynx.app
// XXX How to inject release channel into build? config.json?
export const SQLYNX_GET_URL: string = `https://get.sqlynx.app/canary.json`;
// The URL of the git repository
export const SQLYNX_GIT_REPO_URL: string = `https://github.com/ankoh/sqlynx/tree/${SQLYNX_GIT_COMMIT}`;
