[![Main](https://github.com/duckdb/duckdb-wasm/actions/workflows/main.yml/badge.svg)](https://github.com/duckdb/duckdb-wasm/actions/workflows/main.yml)
[![npm](https://img.shields.io/npm/v/@duckdb/duckdb-wasm?logo=npm)](https://www.npmjs.com/package/@duckdb/duckdb-wasm/v/latest)

**FlatSQL**

FlatSQL is a *just* flat representation of a PostgreSQL AST.
The library provides a bison parser that materializes shallow AST Nodes into a single compact array.
It can be compiled to WebAssembly and has been originally built for lightweight SQL instrumentation in DashQL.

Each AST node is packed into 24 bytes and references matched substrings in the original script text.
This makes the AST very lightweight and allows analyzing user input with every single keystroke.

<img src="img/ast.png?raw=true" width="680px">