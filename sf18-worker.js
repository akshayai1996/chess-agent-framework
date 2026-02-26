/**
 * sf18-worker.js — Lichess Stockfish 18 WASM Web Worker
 */

let engine = null;
let pendingCommands = []; // queue for commands that arrive before WASM/NNUE is ready
let isInitializing = false;

async function initEngine() {
    if (isInitializing) return;
    isInitializing = true;
    
    try {
        postMessage("worker-info: Loading sf_18.js module...");
        const { default: Sf18 } = await import('./sf_18.js');
        
        postMessage("worker-info: Instantiating WASM...");
        engine = await Sf18({
            locateFile: (file) => {
                // Handle both .wasm and .data files
                if (file.endsWith('.wasm')) return './sf_18.wasm';
                if (file.endsWith('.data')) return './sf_18.data';
                return `./${file}`;
            },
            listen: (line) => {
                if (line && typeof line === 'string') {
                    postMessage(line);
                }
            },
            printErr: (line) => {
                if (line && typeof line === 'string') {
                    postMessage("worker-stderr: " + line);
                }
            }
        });

        // Stockfish 18 NNUE from Lichess requires fetching the neural networks manually
        postMessage("worker-info: Downloading NNUE files sequentially...");
        
        // Try both naming conventions (Lichess vs official)
        const nnueFiles = [
            { url: './nn-c288c895ea92.nnue', type: 0 },  // big
            { url: './nn-37f18f62d772.nnue', type: 1 }   // small
        ];
        
        const results = [];
        for (const file of nnueFiles) {
            try {
                const resp = await fetch(file.url);
                results.push({ status: 'fulfilled', value: resp });
            } catch (err) {
                results.push({ status: 'rejected', reason: err });
            }
        }
        
        postMessage("worker-info: Fetches finished, processing results...");
        
        // Check if all fetches succeeded
        const failedFetches = results.filter(r => r.status === 'rejected' || !r.value.ok);
        if (failedFetches.length > 0) {
            throw new Error(`Failed to load NNUE files: ${failedFetches.length} failed`);
        }
        
        // Process successful responses
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'fulfilled' && results[i].value.ok) {
                postMessage(`worker-info: Reading arrayBuffer for ${nnueFiles[i].url}...`);
                const buffer = await results[i].value.arrayBuffer();
                const nnueData = new Uint8Array(buffer);
                
                postMessage(`worker-info: Injecting ${nnueFiles[i].url} into WASM (${nnueData.byteLength} bytes)...`);
                // Try different method names
                if (typeof engine.setNnueBuffer === 'function') {
                    engine.setNnueBuffer(nnueData, nnueFiles[i].type);
                } else if (typeof engine.setNNUEFile === 'function') {
                    engine.setNNUEFile(nnueData, nnueFiles[i].type);
                } else if (typeof engine.setNnueFile === 'function') {
                    engine.setNnueFile(nnueData, nnueFiles[i].type);
                } else {
                    console.warn('NNUE set method not found, trying direct memory write');
                    postMessage("worker-error: No valid setNnue function found in engine");
                }
                postMessage(`worker-info: Injected ${nnueFiles[i].url}`);
            }
        }
        
        postMessage("worker-info: Initialized!");
        postMessage("worker-ready");

        // Replay any commands that arrived during loading
        for (const cmd of pendingCommands) {
            engine.uci(cmd);
        }
        pendingCommands = [];

    } catch (e) {
        postMessage("worker-error: " + e.message);
        console.error('Engine initialization failed:', e);
    } finally {
        isInitializing = false;
    }
}

onmessage = function(e) {
    const cmd = e.data;
    postMessage(`worker-info: Received command: ${cmd}`);
    
    // Handle special commands
    if (cmd === "init") {
        initEngine();
    } else if (cmd === "quit" && engine) {
        engine.uci("quit");
    } else if (engine && pendingCommands.length === 0 && !isInitializing) {
        try {
            engine.uci(cmd);
            postMessage(`worker-info: Executed engine.uci('${cmd}')`);
        } catch(err) {
            postMessage(`worker-error: uci error: ${err.message}`);
        }
    } else {
        postMessage(`worker-info: Queued command: ${cmd} (engine=${!!engine}, isInitializing=${isInitializing})`);
        pendingCommands.push(cmd);
    }
};
