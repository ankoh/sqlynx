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

The wasm-bindgen API is the `Shell` class of `dashql-shell-wasm` (`//packages/dashql-core-rs:shell_wasm`), which also
re-exports the core bindings. Shell instances are independent and results are owned by JavaScript. Arrow rendering is
internal to the query workflow; consumers execute queries through the database effect interface rather than passing
result buffers to a public rendering function.

The TypeScript binding lives in `packages/dashql-app/src/shell`. Its root entrypoint exports
`createDashQLShell({ environment, ... })` and `createDuckDBShellEnvironment(connection)`. The environment returns Arrow IPC
file bytes from `executeQuery()`, while the shell owns effect dispatch, cancellation, coroutine resumption, input handling,
and ANSI terminal rendering. The browser controller only creates and disposes xterm, forwards terminal dimensions and raw
input events, executes requested host effects, and writes the bytes returned by Wasm. Terminal rendering logic must not be
implemented or duplicated in TypeScript.

Build and test through Bazel:

```bash
bazel test //packages/dashql-core-rs:shell_api_test //packages/dashql-core-rs:shell_arrow_renderer_test \
    //packages/dashql-core-rs:shell_prompt_buffer_test //packages/dashql-core-rs:shell_differential_test
bazel build //packages/dashql-core-rs:shell_wasm
```

Prompt text uses a contiguous UTF-8 buffer with cached grapheme boundaries. Cursor movement and deletion operate on
extended grapheme clusters, while cursor positions remain UTF-8 byte offsets for parser and host interoperability.

The Rust shell is the single source of truth for shell behavior and rendering. New highlighting, completion
presentation, cursor, redraw, history, and status behavior belongs in the Rust shell code, not in the TypeScript xterm
host. The C++ shell in `packages/dashql-core/src/shell` only remains as the oracle of `:shell_differential_test`.
