import eslint from '@eslint/js';
import ts from 'typescript-eslint';

const config = ts.config(
    eslint.configs.recommended,
    ...ts.configs.recommended,
    {
        // ...
        "rules": {
            // Turn off unused vars as it can report incorrect errors
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                // Ignore variables with leading underscore
                {
                    "argsIgnorePattern": "^_",
                    "varsIgnorePattern": "^_",
                    "caughtErrorsIgnorePattern": "^_"
                }
            ]
        }
    },
    {
        "ignores": [
            "target/*",
            "node_modules/*",
            "packages/sqlynx-app/build",
            "packages/sqlynx-core",
            "packages/sqlynx-native",
            "packages/sqlynx-pack",
            "packages/sqlynx-core-bindings/dist",
            "packages/sqlynx-core-bindings/gen",
            "packages/sqlynx-protobuf/dist",
            "packages/sqlynx-protobuf/gen",
        ],
    }
);
export default config;
