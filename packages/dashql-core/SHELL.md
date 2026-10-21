# DashQL Shell

The shell (`dashql_core::shell`) is the Rust/WebAssembly core of an embeddable SQL terminal. It owns the complete terminal state machine
and terminal rendering, including prompt redraws, syntax highlighting, cursor placement, completion lists, status and
error output, and width-constrained UTF-8 tables. It deliberately does not own the xterm object, a database, or browser
APIs.

The current boundary is:

```text
shell environment -> Arrow IPC -> dashql-shell Wasm -> terminal text -> xterm host
```

Asynchronous shell workflows are explicit pending effects. An operation that needs the host returns a pending status
with an effect envelope (version, type, id, payload); JavaScript performs the Promise-based operation and resumes the
workflow through `Shell.completeEffect` or `Shell.cancelEffect`. This avoids Asyncify and JSPI while keeping workflow
ownership in Rust.

The wasm-bindgen API is the `Shell` class of `dashql-shell-wasm` (`//packages/dashql-shell-wasm:shell_wasm`), which also
re-exports the core bindings. Shell instances are independent and results are owned by JavaScript. Arrow rendering is
internal to the query workflow; consumers execute queries through the database effect interface rather than passing
result buffers to a public rendering function.

Result tables are drawn by `shell::arrow_renderer`, which formats cell values with arrow-cast's `ArrayFormatter`
(one formatter per column): floats with their shortest round-trip digits, temporal values in ISO 8601, binaries in
hex, nested values as `[1, null, 3]` or `{x: 1, y: a}`. Null cells are empty, numbers and booleans are
right-aligned. Timestamps with a named time zone are shown in UTC because chrono-tz is not linked, and a column of a
type that arrow-cast cannot format shows its type name. Values do not print like the former C++ shell (Arrow C++
`Scalar::ToString`), see `docs/rust-port/quirks.md`.

The TypeScript binding lives in `packages/dashql-app/src/shell`. Its root entrypoint exports
`createDashQLShell({ environment, ... })` and `createDuckDBShellEnvironment(connection)`. The environment returns Arrow IPC
file bytes from `executeQuery()`, while the shell owns effect dispatch, cancellation, coroutine resumption, input handling,
and ANSI terminal rendering. The browser controller only creates and disposes xterm, forwards terminal dimensions and raw
input events, executes requested host effects, and writes the bytes returned by Wasm. Terminal rendering logic must not be
implemented or duplicated in TypeScript.

Build and test through Bazel:

```bash
bazel test //packages/dashql-core:shell_api_test //packages/dashql-core:shell_arrow_renderer_test \
    //packages/dashql-core:shell_prompt_buffer_test
bazel build //packages/dashql-shell-wasm:shell_wasm
```

Prompt text uses a contiguous UTF-8 buffer with cached grapheme boundaries. Cursor movement and deletion operate on
extended grapheme clusters, while cursor positions remain UTF-8 byte offsets for parser and host interoperability.
Clusters come from `unicode-segmentation` and occupy the terminal columns of `unicode-width`; clusters that start with a
control character take no columns, and text that is not valid UTF-8 takes one column per byte (`shell::unicode`).

The Rust shell is the single source of truth for shell behavior and rendering. New highlighting, completion
presentation, cursor, redraw, history, and status behavior belongs in the Rust shell code, not in the TypeScript xterm
host.
