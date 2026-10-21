<p align="center">
  <img src="misc/logo-dashql-glyphs/logo.png" width=100>
</p>
<p align="center">
  <a href="https://github.com/ankoh/dashql/actions/workflows/on_push_main.yml"><img src="https://github.com/ankoh/dashql/actions/workflows/on_push_main.yml/badge.svg?branch=main" /></a>
  <a href="https://github.com/ankoh/dashql/actions/workflows/renovate.yml"><img src="https://github.com/ankoh/dashql/actions/workflows/renovate.yml/badge.svg" /></a>
  <a href="https://coveralls.io/github/ankoh/dashql?branch=main"><img src="https://coveralls.io/repos/github/ankoh/dashql/badge.svg?branch=main" /></a>
  <a href="https://opensource.org/licenses/MPL-2.0"><img src="misc/badge_mpl2.svg?raw=true" /></a>
  <a href="https://get.dashql.app/canary.json"><img src="https://get.dashql.app/channels/canary/badge.svg" /></a>
</p>

---

DashQL is a library for creating and analyzing a compact version of the PostgreSQL AST.
It builds around a Bison parser that materializes AST Nodes into a single Flatbuffer vector.
It can be compiled to WebAssembly and has been originally built for lightweight SQL instrumentation, running on every user keystroke in DashQL.

_Each AST node is packed into [24 bytes](https://github.com/ankoh/dashql/blob/b95b3f0959f3a17db8378e79d0adb2fa29925a93/proto/fb/dashql/parsed_script.fbs#L357-L364) and references matched substrings in the original script text.
This encoding is compact and efficient for simple passes, but is not directly suited for a full semantic analysis._

<img src="misc/ast.png?raw=true" width="680px">

---

### Building

```
# Vite dev server for the browser with HMR.
bazel run //packages/dashql-app:dev

# For Electron renderer HMR, run these in separate terminals.
bazel run //packages/dashql-app:dev -- --mode electron
bazel run //packages/dashql-native:dev
# Override DASHQL_ELECTRON_RENDERER_URL if Vite uses another loopback HTTP origin.

# If you need demangled wasm stacktraces, run with
bazel run --config=debug //packages/dashql-app:dev

# We bundle the web app with two routers
# - '/'-paths for Cloudflare Pages -> :pages
# - '#/'-paths for native apps -> :reloc
bazel build //packages/dashql-app:pages
bazel build //packages/dashql-app:reloc

# The native app can be cross-compiled for arm and x86
bazel run //packages/dashql-native:mac_package_arm64
bazel run //packages/dashql-native:mac_package_x86_64

# Test everything
bazel test //...

# Many tests are backed by snapshots / fixtures
# /snapshots/*.tpl.yaml are the input to generate /snapshots/*.yaml
# Update a snapshot category after intentional changes:
bazel run //snapshots/analyzer:update
bazel run //snapshots/completion:update
bazel run //snapshots/diff:update
bazel run //snapshots/formatter:update
bazel run //snapshots/parser:update
bazel run //snapshots/planner:update
bazel run //snapshots/plans/hyper/tests:update
bazel run //snapshots/visualize:update

# Upgrade the Rust crates declared in bazel/crates/*.MODULE.bazel
bazel run //scripts:repin_crates -- full

# Fetch test datasets
bazel build //packages/dashql-datasets:datasets
# Upload missing test datasets to data.dashql.app (requires R2 key)
bazel run //packages/dashql-datasets:sync

```

---

### Continuous Deployment

- We're continuously deploying main to [dashql.app](https://dashql.app)
    - `//packages/dashql-app:pages` is published to Cloudflare Pages
    - We use aggressive caching with cache busting
- Native apps and update bundles are published to **get.dashql.app**
- We're maintaining release manifests under [get.dashql.app/stable.json](https://get.dashql.app/stable.json) and [get.dashql.app/canary.json](https://get.dashql.app/canary.json)
- Hosted test datasets are published to **data.dashql.app** (R2 bucket `dashql-data`)
    - Built hermetically by `//packages/dashql-datasets` (hash-pinned sources -> DuckDB CLI) and mirrored with `bazel run //packages/dashql-datasets:sync`
    - Immutable versioned paths `data.dashql.app/<dataset>/v<version>/<file>.parquet`, plus a mutable `data.dashql.app/index.json` registry
- Our builds heavily rely on a bazel-remote cache server under [bazel-cache.dashql.app](https://bazel-cache.dashql.app)
- You can see bazel cache statistics [here](https://bazel-cache.dashql.app/public-dashboards/a9d003b26c7c4da6962c2c9bf3e5c329)
