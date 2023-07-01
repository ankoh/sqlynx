// Those types are not declared by TypeScript for node
// environments, but they do exist.
// We don't actually use them in this module, but we
// need their declarations so the `.d.ts` files from the
// main `flatsql` package can be loaded successfully.

interface TextEncoder {}
interface TextDecoder {}
