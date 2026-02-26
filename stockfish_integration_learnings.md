# Stockfish WASM Integration: Key Learnings & Architecture Fixes

This document outlines the hard-fought architectural lessons we learned while migrating our chess engine from a basic CDN-based Stockfish 10 to a modern, state-of-the-art Stockfish 18 NNUE (Neural Network Updated Evaluation) WASM build inside the browser.

## 1. Web Workers & Asynchronous Command Queuing

**The Problem:** Direct execution of the WASM module (`engine.uci("play")`) from the browser's main thread results in silent command dropping and fatal engine freezes. The WASM module operates synchronously and cannot handle high-throughput commands interrupting its internal search tree.
**The Fix:** Modern Stockfish builds require the **Lichess web-worker wrapper pattern**. The WASM engine must be isolated entirely inside a Web Worker thread. The main UI thread then communicates strictly via `postMessage()`. The Worker serializes incoming UCI commands into a queue, giving the WASM module the same standard input/output (stdin/stdout) environment as a C++ terminal.

## 2. Race Conditions During WASM Compilation

**The Problem:** We were sending the initial `uci` handshake instantly, but the WASM `.js` layer requires significant time to parse and compile the WebAssembly binary. Our `uci` command arrived before the engine object existed, disappearing into the void, causing a permanent timeout on `uciok`.
**The Fix:** The Worker must implement a formal `pendingCommands` queue. Any commands arriving while `isInitializing` is true must be delayed and replayed sequentially only _after_ the WebAssembly runtime broadcasts its `worker-ready` event.

## 3. The Size Limit of NNUE (Neural Networks)

**The Problem:** Stockfish 18 uses Neural Networks that are massive (a "big" 100MB+ net and a "small" 3MB+ net). WebAssembly cannot natively bundle 100MB+ files into its `.wasm` binary gracefully.
**The Fix:** The neural networks (`.nnue`) must be physically downloaded as separate `arrayBuffer` blobs in JavaScript, and then explicitly injected directly into the WebAssembly memory heap using specialized C-bindings (e.g., `engine.setNnueBuffer(data, memoryIndex)`).

## 4. Multithreading Security Constraints (SharedArrayBuffer)

**The Problem:** Stockfish 18 utilizes WebAssembly Threads to analyze multiple lines at once. Modern browsers actively block the `SharedArrayBuffer` API (due to Spectre vulnerability mitigations) unless the host server proves it's safe.
**The Fix:** The web server _must_ inject strict CORS isolation headers into its HTTP response:

- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Opener-Policy: same-origin`  
  Without these exact HTTP headers, modern WASM multithreading silently crashes before the module even boots.

## 5. Python Server Deadlocks & Concurrent Fetches

**The Problem:** Python's standard `http.server` is single-threaded. When the browser attempted to download the 100MB NNUE file alongside other scripts, it opened parallel connections. The server blocked on the massive file stream, locking out all other file requests and deadlocking the entire application.
**The Fix:** We rewrote the local dev server using `socketserver.ThreadingTCPServer()`. This spins up a dedicated thread per HTTP request, completely eliminating I/O bottlenecks and allowing massive NNUE files to download alongside HTML components smoothly.

## Summary

Building web-based Stockfish is no longer just plugging in a script. It requires treating the browser as a mini Operating System: establishing secure cross-origin memory boundaries, deploying dedicated thread workers for async I/O separation, manually paging Neural Networks into RAM, and writing multithreaded backend asset servers.
