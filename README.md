<img src="/misc/logo.svg" height="24">

[![Main](https://github.com/ankoh/flatsql/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/ankoh/flatsql/actions/workflows/main.yml)
[![Renovate](https://github.com/ankoh/flatsql/actions/workflows/renovate.yml/badge.svg)](https://github.com/ankoh/flatsql/actions/workflows/renovate.yml)
[![Coverage](https://coveralls.io/repos/github/ankoh/flatsql/badge.svg?branch=main)](https://coveralls.io/github/ankoh/flatsql?branch=main)
[![License](misc/badge_mpl2.svg?raw=true)](https://opensource.org/licenses/MPL-2.0)
[![Status](misc/badge_wip.svg?raw=true)](https://github.com/ankoh/flatsql/commits/main)

---

FlatSQL is a flat representation of a PostgreSQL AST.
The library provides a Bison parser that materializes AST Nodes into a single compact Flatbuffer vector.
It can be compiled to WebAssembly and has been originally built for lightweight SQL instrumentation, running on every user keystroke in DashQL.

_Each AST node is packed into [24 bytes](https://github.com/ankoh/flatsql/blob/a42476e170538a4050511259763a3e4d08b989ac/proto/flatsql/program.fbs#L355-L361) and references matched substrings in the original script text.
This encoding is compact and efficient for simple passes, but is not directly suited for a full semantic analysis._

<img src="misc/ast.png?raw=true" width="680px">

---

### Building

```
# Setup
make infra_macos  # or infra_linux, depending on your system
yarn install

# Building the libraries
make proto
make lib
make lib_relwithdebinfo
make wasm_release
make jslib_release

# Testing
make lib_tests
make jslib_tests

# Update dumps
make parser_dumps
make analyzer_dumps

# Benchmarking
make benchmark_steps

# Build the LSP & VS Code extension
make lsp
make vscode
# run the VS code extension through the "Launch VSCode Plugin" launch configuration

# Start editor dev server
make editor_start
```
