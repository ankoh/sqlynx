**FlatSQL**

FlatSQL is a flat representation of a PostgreSQL AST.
The library does NOT provide a full-blown syntactic or semantic analysis for database systems.
It only consists of a bison parser that materializes shallow AST Nodes into a single compact node array.
FlatSQL can be compiled to WebAssembly and has been built for lightweight SQL instrumentation.
