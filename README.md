**FlatSQL**

FlatSQL is a flat representation of a PostgreSQL AST.
The library provides a bison parser that materializes shallow AST Nodes into a single compact node array.
It can be compiled to WebAssembly and has been built for lightweight SQL instrumentation.