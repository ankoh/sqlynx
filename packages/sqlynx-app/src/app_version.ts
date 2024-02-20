// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_VERSION: string = process.env.SQLYNX_VERSION!;
// Injected through the DefinePlugin in webpack.common.ts
export const SQLYNX_GIT_COMMIT: string = process.env.SQLYNX_GIT_COMMIT!;

// The URL of the git repository
export const SQLYNX_GIT_REPO_URL: string = `https://github.com/ankoh/sqlynx/tree/${SQLYNX_GIT_COMMIT}`;
