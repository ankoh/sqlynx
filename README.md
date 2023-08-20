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
make lib_o0
make lib_o2
make wasm_o3
make jslib_o3

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

---

### Incremental parsing with Tree-sitter?

Tree-sitter is a great parser framework and I recommend everyone to try it out.
It gives you flexible incremental parsing without much hassle and is a perfect fit for many editors.

FlatSQL was built for specific database systems.
The systems Hyper, Umbra, NoisePage, AlloyDB and DuckDB all use Bison parsers derived from the PostgreSQL grammar.
The PostgreSQL grammar stood the test of time and established itself as de-facto reference for SQL syntax.
Staying close to PostgreSQL simplifies building frontends for these database systems without worrying too much about grammar differences.
FlatSQL builds around a carefully optimized and very fast PostgreSQL parser to provide lightweight semantic analysis passes, running on every single keystroke.

FlatSQL is still doing work in `O(text-length)` with every input event, as opposed to `O(change-size)` by Tree-sitter.
Yet, FlatSQL analyzes most input in well under a millisecond in your browser, even when replacing the entire text.
After all, the parser is not the only component that has to be tuned for fast analysis passes, incremental parsing alone "only" gives you a head-start for the AST update.
FlatSQL maintains B+-tree ropes, dictionary-encodes SQL object names in-flight, performs efficient post-order DFS traversals through linear scans over a compact AST representation and maintains identifier suffixes in lightweight adaptive radix trees.

Analyzing TPC-DS Q1 takes around 50 microseconds and you should not notice FlatSQL for queries up to 50 times that text size.
