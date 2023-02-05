**FlatSQL**

FlatSQL is a flat representation of a PostgreSQL AST.
The library provides a Bison parser that materializes shallow AST Nodes into a single compact Flatbuffer vector.
It can be compiled to WebAssembly and has been originally built for lightweight SQL instrumentation, running on every user keystroke in DashQL.

*Each AST node is packed into 24 bytes and references matched substrings in the original script text.
This encoding is compact and efficient for simple passes, but is not directly suited for a full semantic analysis.*

<img src="misc/ast.png?raw=true" width="680px">