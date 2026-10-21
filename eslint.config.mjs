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
            ],
            "no-restricted-imports": [
                "error",
                {
                    "paths": [
                        {
                            "name": "immutable",
                            "importNames": [
                                "default"
                            ],
                            "message": "Use `import * as Immutable from 'immutable'` or named imports; immutable has no ESM default export in Vite."
                        }
                    ]
                }
            ]
        }
    },
    {
        "ignores": [
            "bazel-*",
            "target/*",
            "node_modules/*",
            "packages/dashql-pack/**",
        ],
    }
);
export default config;
