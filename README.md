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
make infra_macos          # Install dependencies to .infra, `infra_linux` for linux
yarn install              # Install npm packages

make proto                # Generate flatbuffers

make core_native_o0       # Build unoptimized native core library
make core_native_o2       # Build optimized native core library with debug symbols
make core_native_tests    # Run native tests
make core_wasm_o3         # Build optimized wasm core library
make core_js_o3           # Build js bundle with wasm module and js api
make core_js_tests        # Run js tests using the wasm module

make snapshots            # Update parser snapshots

make benchmark_pipeline   # Benchmark the processing pipeline
make benchmark_layout     # Benchmark the schema graph layout

make lsp                  # Build the lsp library
make vscode               # Build the vscode extension

make editor_start         # Start the dev server for the editor
```

---

### Incremental parsing with Tree-sitter?

Tree-sitter is a great parser framework and I recommend everyone to try it out.
It gives you flexible incremental parsing without much hassle and is a perfect fit for many editors.

FlatSQL was built for specific database systems.
The systems Hyper, Umbra, NoisePage, AlloyDB and DuckDB all use Bison parsers derived from the PostgreSQL grammar.
The PostgreSQL grammar stood the test of time and established itself as de-facto reference for SQL syntax.
Staying close to PostgreSQL simplifies building frontends for these database systems without worrying too much about grammar differences.
FlatSQL builds around a carefully optimized and very fast parser based on the PostgreSQL-grammar to provide lightweight semantic analysis passes, running on every single keystroke.

FlatSQL is still doing work in `O(text-length)` with every input event, as opposed to `O(change-size)` by Tree-sitter.
Yet, FlatSQL analyzes most input in well under a millisecond in your browser, even when replacing the entire text.
After all, the parser is not the only component that has to be tuned for fast analysis passes, incremental parsing alone "only" gives you a head-start for the AST update.
FlatSQL maintains B+-tree ropes, dictionary-encodes and tags SQL object names in-flight and performs efficient post-order DFS traversals through linear scans over a compact AST representation.

---

### What does "fast" mean in numbers?

Here are timings for TPC-DS Q1 on my laptop. All steps run single-threaded on a M1Max.
FlatSQL spends **5us** with scanning, **10us** with parsing, **12us** with analyzing and **5us** with building the completion index.

```
Run on (10 X 24.1205 MHz CPU s)
CPU Caches:
  L1 Data 64 KiB
  L1 Instruction 128 KiB
  L2 Unified 4096 KiB (x10)
Load Average: 3.75, 4.03, 3.74
----------------------------------------------------------
Benchmark                Time             CPU   Iterations
----------------------------------------------------------
scan_query            4975 ns         4974 ns       125538
parse_query          10236 ns        10235 ns        68102
analyze_query        12395 ns        12380 ns        56937
index_query           5031 ns         5031 ns       136992
move_cursor           75.5 ns         75.4 ns      9203624
complete_cursor       6194 ns         6173 ns       109764
```
