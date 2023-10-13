<p align="center">
  <img src="https://github.com/ankoh/dashql/blob/92c1d353f6dad17a427e2d3326d518eb5871fe50/packages/core/static/favicons/android-chrome-512x512.png" width=88 style="padding: 8px; background: black;">
</p>
<p align="center">
  <a href="https://github.com/ankoh/flatsql/actions/workflows/main.yml"><img src="https://github.com/ankoh/flatsql/actions/workflows/main.yml/badge.svg?branch=main" /></a>
  <a href="https://github.com/ankoh/flatsql/actions/workflows/renovate.yml"><img src="https://github.com/ankoh/flatsql/actions/workflows/renovate.yml/badge.svg" /></a>
  <a href="https://coveralls.io/github/ankoh/flatsql?branch=main"><img src="https://coveralls.io/repos/github/ankoh/flatsql/badge.svg?branch=main" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img src="misc/badge_mpl2.svg?raw=true" /></a>
  <a href="https://github.com/ankoh/flatsql/commits/main"><img src="misc/badge_wip.svg?raw=true" /></a>
</p>

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
make snapshots            # Update snapshots
make benchmark_pipeline   # Benchmark the processing pipeline

make lsp                  # Build the lsp library
make vscode               # Build the vscode extension

make app_start            # Start the dev server for the PWA
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
Run on (10 X 24.1194 MHz CPU s)
CPU Caches:
  L1 Data 64 KiB
  L1 Instruction 128 KiB
  L2 Unified 4096 KiB (x10)
Load Average: 4.82, 4.40, 3.82
----------------------------------------------------------
Benchmark                Time             CPU   Iterations
----------------------------------------------------------
scan_query            5037 ns         5032 ns       125372
parse_query          10199 ns        10193 ns        68720
analyze_query        12504 ns        12502 ns        54143
index_query           4994 ns         4990 ns       138274
move_cursor           77.1 ns         77.1 ns      9054105
complete_cursor       6121 ns         6121 ns       111378
compute_layout       11091 ns        11090 ns        62143
```
