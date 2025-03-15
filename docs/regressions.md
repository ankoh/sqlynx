# March 2025

Recursive stack protection is causing problems with older LLVM versions:
https://github.com/rustwasm/wasm-pack/issues/1381#issuecomment-2153142927

Fix by using LLVM 19 from Homebrew
```
export PATH=/opt/homebrew/opt/llvm/bin:$PATH
```

