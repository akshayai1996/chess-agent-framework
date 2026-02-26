/**
 * engine.js — Stockfish Integration & Evaluation Logic
 *
 * Supports TWO engine backends:
 *   1. Local: Stockfish 17.1 WASM/NNUE (sf17_1-79.js)
 *   2. CDN:   Stockfish 10 Web Worker (stockfish.js from CDN)
 *
 * Evaluation orientation: WHITE-PERSPECTIVE
 *   positive = White is better, negative = Black is better.
 *   Stockfish reports scores from the SIDE-TO-MOVE perspective,
 *   so we invert when it's Black's turn.
 *
 * Depends on globals from analyser.html:
 *   - game, isAutoPlaying, highlightSquare
 */

let stockfish = null;       // engine handle (varies by backend)
let engineEnabled = false;
let engineReady = false;
let lastEvalUpdate = 0;
let currentAnalysisFen = '';
let analysisTimeout = null;
let awaitingUciOk = false;
let analysisGen = 0;
let currentAnalysisGen = 0;
let engineBackend = 'cdn';  // 'local' or 'cdn'

/* ── Helpers ── */

function engineLog(msg) {
    const el = document.getElementById("fen-debug");
    if (el) el.innerText = msg;
    console.log("[engine]", msg);
}
function debugLog(msg) {
    const el = document.getElementById("debug-log");
    if (el) { el.style.display = 'block'; el.innerText = msg; }
    console.log("[debug]", msg);
}
function turnFromFen(fen) {
    if (!fen) return 'w';
    const parts = fen.split(/\s+/);
    return (parts.length >= 2 && parts[1] === 'b') ? 'b' : 'w';
}

/**
 * Unified command sender — both backends are Web Workers now
 */
function sendUci(cmd) {
    if (!stockfish) return;
    try {
        stockfish.postMessage(cmd);
    } catch (e) {
        console.error("sendUci error:", e, "cmd:", cmd);
    }
}

/**
 * Unified line handler — called for every engine output line
 */
function handleEngineLine(rawLine) {
    if (!rawLine || typeof rawLine !== 'string') return;
    const line = rawLine.trim();
    if (!line) return;

    const indicatorEl = document.getElementById("status-indicator");
    const engineInfo  = document.getElementById("engine-info");
    const engineNameEl = document.getElementById("engine-name");

    /* ── uciok ── */
    if (line.startsWith('uciok')) {
        awaitingUciOk = false;
        engineLog("uciok — sending options");
        const threads = 1;  // CDN version often only supports 1
        sendUci("setoption name Hash value 32");
        if (engineBackend === 'local') {
            const t = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
            sendUci("setoption name Threads value " + t);
            sendUci("setoption name UCI_ShowWDL value true");
        }
        sendUci("isready");
        return;
    }

    /* ── id name ── */
    if (line.startsWith('id name ')) {
        if (engineNameEl) engineNameEl.innerText = line.replace(/^id name\s+/, '');
        return;
    }

    /* ── info ── */
    if (line.startsWith("info ")) {
        parseEval(line);
        return;
    }

    /* ── bestmove ── */
    if (line.startsWith("bestmove")) {
        parseBestMove(line);
        return;
    }

    /* ── readyok ── */
    if (line.startsWith("readyok")) {
        if (indicatorEl) {
            indicatorEl.classList.remove('bg-yellow-500', 'bg-red-500', 'animate-pulse');
            indicatorEl.classList.add('bg-green-500');
        }
        if (engineInfo) engineInfo.innerText = "Active";
        engineReady = true;
        engineLog("readyok — engine ready");
        if (engineEnabled) runAnalysis();
        return;
    }
}

/* ─────────────────────────────────────────────
   1.  Engine Initialisation
   ───────────────────────────────────────────── */

async function initEngine() {
    if (stockfish) return;

    const indicatorEl = document.getElementById("status-indicator");
    const engineInfo  = document.getElementById("engine-info");

    // Determine backend from dropdown (if exists)
    const sel = document.getElementById("engine-backend");
    if (sel) engineBackend = sel.value;

    try {
        if (indicatorEl) {
            indicatorEl.classList.add('animate-pulse');
            indicatorEl.classList.remove('bg-red-500', 'bg-green-500');
            indicatorEl.classList.add('bg-yellow-500');
        }

        if (engineBackend === 'cdn') {
            /* ── Stockfish 10 Web Worker ── */
            if (engineInfo) engineInfo.innerText = "Loading Stockfish 10…";
            engineLog("Loading Stockfish 10…");

            const worker = new Worker("stockfish-10.js");
            worker.onmessage = (e) => handleEngineLine(e.data);
            worker.onerror = (e) => {
                engineLog("Worker error: " + e.message);
                if (engineInfo) engineInfo.innerText = "Load Failed";
            };
            stockfish = worker;
            
            awaitingUciOk = true;
            sendUci("uci");
            setTimeout(() => {
                if (awaitingUciOk) {
                    console.warn("SF10 UCI handshake timeout");
                    engineLog("SF10 uciok TIMEOUT — forcing isready");
                    awaitingUciOk = false;
                    sendUci("isready");
                }
            }, 5000);

        } else {
            /* ── Stockfish 18 WASM via Web Worker (Lichess pattern) ── */
            if (engineInfo) engineInfo.innerText = "Loading Stockfish 18…";
            engineLog("Loading SF 18 via Worker…");

            const worker = new Worker("sf18-worker.js", { type: "module" });
            worker.onmessage = (e) => {
                const line = e.data;
                if (line === "worker-ready") {
                    engineLog("SF18 Worker ready — sending uci");
                    awaitingUciOk = true;
                    sendUci("uci");
                    setTimeout(() => {
                        if (awaitingUciOk) {
                            console.warn("UCI handshake timeout");
                            engineLog("uciok TIMEOUT — forcing isready");
                            awaitingUciOk = false;
                            sendUci("isready");
                        }
                    }, 5000);
                    return;
                }
                if (typeof line === 'string' && line.startsWith("worker-info:")) {
                    engineLog("SF18 " + line.substring(12).trim());
                    return;
                }
                if (typeof line === 'string' && line.startsWith("worker-error")) {
                    engineLog("SF18 Error: " + line);
                    if (engineInfo) engineInfo.innerText = "Load Failed (See Debug)";
                    return;
                }
                handleEngineLine(line);
            };
            worker.onerror = (e) => {
                engineLog("SF18 Worker error: " + e.message);
                if (engineInfo) engineInfo.innerText = "Load Failed";
            };
            stockfish = worker;
            // Tell the worker to init the WASM module
            worker.postMessage("init");
        }
    } catch (e) {
        if (engineInfo) engineInfo.innerText = "Load Failed";
        if (indicatorEl) {
            indicatorEl.classList.remove('bg-yellow-500', 'bg-green-500', 'animate-pulse');
            indicatorEl.classList.add('bg-red-500');
        }
        engineLog("LOAD FAILED: " + e.message);
        console.error("Engine Load Error:", e);
        stockfish = null;
        engineReady = false;
    }
}

/* ─────────────────────────────────────────────
   2.  Toggle Engine On / Off
   ───────────────────────────────────────────── */

function toggleEngine() {
    engineEnabled = document.getElementById("engine-toggle").checked;
    const bestMoveText = document.getElementById("best-move-text");
    const evalDisplay  = document.getElementById("eval-display");
    const indicatorEl  = document.getElementById("status-indicator");

    if (engineEnabled) {
        if (bestMoveText) bestMoveText.style.display = "block";
        initEngine();
    } else {
        if (bestMoveText) bestMoveText.style.display = "none";

        if (stockfish) {
            try { sendUci("stop"); } catch (_) {}
            if (engineBackend === 'cdn' && typeof stockfish.terminate === 'function') {
                try { stockfish.terminate(); } catch (_) {}
            }
        }
        stockfish = null;
        engineReady = false;
        clearTimeout(analysisTimeout);
        analysisGen++;

        if (evalDisplay) evalDisplay.innerText = "0.00";
        if (indicatorEl) {
            indicatorEl.classList.remove('animate-pulse', 'bg-green-500', 'bg-red-500');
            indicatorEl.classList.add('bg-yellow-500');
            indicatorEl.style.backgroundColor = '';
        }
        engineLog("Engine disabled");
    }
}

/* ─────────────────────────────────────────────
   3.  Trigger Analysis
   ───────────────────────────────────────────── */

let pendingFen = null;  // For local WASM: FEN waiting for readyok

function runAnalysis() {
    if (!stockfish || !engineReady) return;
    if (typeof isAutoPlaying !== 'undefined' && isAutoPlaying) return;

    clearTimeout(analysisTimeout);
    analysisGen++;
    const myGen = analysisGen;
    currentAnalysisGen = myGen;

    analysisTimeout = setTimeout(() => {
        if (myGen !== analysisGen) return;

        const fen = (typeof game !== 'undefined') ? game.fen() : '';
        if (!fen) return;

        if (typeof game !== 'undefined' && game.game_over()) {
            const evalDisplay = document.getElementById("eval-display");
            const engineInfo = document.getElementById("engine-info");
            const indicatorEl = document.getElementById("status-indicator");
            const bestMoveText = document.getElementById("best-move-text");
            const engineDepthEl = document.getElementById("engine-depth");
            const engineNpsEl = document.getElementById("engine-nps");
            
            if (indicatorEl) {
                indicatorEl.classList.remove('animate-pulse', 'bg-yellow-500', 'bg-green-500');
                indicatorEl.classList.add('bg-red-500');
            }
            if (bestMoveText) bestMoveText.style.display = "none";
            if (engineInfo) engineInfo.innerText = "Game Over";
            if (engineDepthEl) engineDepthEl.innerText = "-";
            if (engineNpsEl) engineNpsEl.innerText = "-";
            
            if (game.in_checkmate()) {
                const turn = game.turn();
                const evalType = turn === 'b' ? "1-0" : "0-1"; // White wins if black's turn, Black wins if white's turn
                if (evalDisplay) evalDisplay.innerText = "CHECKMATE";
                if (typeof updateEvalBar === 'function') {
                    updateEvalBar(turn === 'b' ? 10 : -10, evalType);
                }
            } else {
                if (evalDisplay) evalDisplay.innerText = "DRAW";
                if (typeof updateEvalBar === 'function') updateEvalBar(0, "½-½");
            }
            try { sendUci("stop"); } catch(_) {}
            return;
        }

        currentAnalysisFen = fen;
        engineLog("FEN: " + fen);

        /*
         * Both backends are Web Workers now — postMessage provides
         * reliable async queuing (same pattern as Lichess).
         * stop → position → go works correctly.
         */
        sendUci("stop");
        sendUci("position fen " + fen);
        sendUci("go infinite");
        debugLog("Sent: position fen " + fen.substring(0, 30) + "…");

        const turn = turnFromFen(fen);
        const indicatorEl = document.getElementById("status-indicator");
        if (indicatorEl) {
            indicatorEl.classList.add('animate-pulse');
            indicatorEl.classList.remove('bg-green-500', 'bg-red-500');
            indicatorEl.classList.add('bg-yellow-500');
        }
        const engineInfo = document.getElementById("engine-info");
        if (engineInfo) engineInfo.innerText = "Analyzing: " + (turn === 'w' ? 'White' : 'Black');
    }, 20);
}

/* ─────────────────────────────────────────────
   4.  Parse "info" Lines
   ───────────────────────────────────────────── */

function parseEval(line) {
    if (currentAnalysisGen !== analysisGen) return;
    const turn = turnFromFen(currentAnalysisFen);

    try {
        const depthMatch = line.match(/depth\s+(\d+)/);
        const npsMatch   = line.match(/nps\s+(\d+)/);

        const engineDepthEl = document.getElementById("engine-depth");
        const depthBarEl    = document.getElementById("depth-bar");
        const engineNpsEl   = document.getElementById("engine-nps");

        if (depthMatch && engineDepthEl) {
            const d = parseInt(depthMatch[1], 10);
            engineDepthEl.innerText = d;
            if (depthBarEl) depthBarEl.style.width = Math.min((d / 25) * 100, 100) + '%';
        }
        if (npsMatch && engineNpsEl) {
            const n = parseInt(npsMatch[1], 10);
            engineNpsEl.innerText = n > 100000
                ? (n / 100000).toFixed(2) + ' Lakh'
                : (n / 1000).toFixed(1) + 'k';
        }

        if (!line.includes(" score ")) return;

        const scoreMatch = line.match(/score\s+(cp|mate)\s+(-?\d+)/);
        if (scoreMatch) {
            const type = scoreMatch[1];
            const raw  = parseInt(scoreMatch[2], 10);
            const whiteCp = (turn === 'b') ? -raw : raw;

            let evalText  = "0.00";
            let pawnScore = whiteCp / 100;

            if (type === "cp") {
                evalText = (pawnScore > 0 ? "+" : "") + pawnScore.toFixed(2);
            } else if (type === "mate") {
                if (raw === 0) {
                    evalText = "MATE";
                } else {
                    evalText = (whiteCp > 0 ? "+" : "-") + "M" + Math.abs(raw);
                }
            }

            const evalDisplay = document.getElementById("eval-display");
            if (evalDisplay) evalDisplay.innerText = evalText;
            updateEvalBar(type === "cp" ? pawnScore : (whiteCp > 0 ? 10 : -10), evalText);
            lastEvalUpdate = Date.now();

            debugLog("d=" + (depthMatch ? depthMatch[1] : "?") + " " + type + "=" + raw + " white=" + whiteCp + " → " + evalText + " | turn=" + turn);
        }

        /* ── PV ── */
        const pvMatch = line.match(/ pv (.+)$/);
        if (pvMatch) {
            try {
                const uciMoves = pvMatch[1].trim().split(/\s+/).filter(Boolean).slice(0, 4);
                const tempGame = new Chess(currentAnalysisFen);
                const sanMoves = [];
                for (const u of uciMoves) {
                    if (u.length < 4) break;
                    const from = u.substring(0, 2), to = u.substring(2, 4);
                    const promo = u.length > 4 ? u.substring(4) : undefined;
                    const m = promo ? tempGame.move({ from, to, promotion: promo }) : tempGame.move({ from, to });
                    if (m) sanMoves.push(m.san); else break;
                }
                if (sanMoves.length > 0) {
                    const prefix = (turn === 'b') ? "… " : "";
                    const el = document.getElementById("best-move-text");
                    if (el) el.innerText = "Line: " + prefix + sanMoves.join(" ");
                }
            } catch (e) { console.warn("pv→SAN failed:", e); }
        }
    } catch (e) {
        console.error("parseEval error:", e);
    }
}

/* ─────────────────────────────────────────────
   5.  Parse "bestmove" — display in SAN
   ───────────────────────────────────────────── */

function parseBestMove(line) {
    if (currentAnalysisGen !== analysisGen) return;
    const turn = turnFromFen(currentAnalysisFen);
    const parts = line.trim().split(/\s+/);
    const bm = parts[1];
    if (!bm || bm === "(none)") return;

    let display = bm;
    try {
        if (currentAnalysisFen) {
            const g = new Chess(currentAnalysisFen);
            const from = bm.substring(0, 2), to = bm.substring(2, 4);
            const promo = bm.length > 4 ? bm.substring(4) : undefined;
            const m = promo ? g.move({ from, to, promotion: promo }) : g.move({ from, to });
            if (m) display = m.san;
        }
    } catch (_) {}

    const prefix = (turn === 'b') ? "… " : "";
    const el = document.getElementById("best-move-text");
    if (el) el.innerText = "Best Move: " + prefix + display;

    if (typeof highlightSquare === 'function' && bm.length >= 4) {
        highlightSquare(bm.substring(0, 2), "best-move");
        highlightSquare(bm.substring(2, 4), "best-move");
    }
}

/* ─────────────────────────────────────────────
   6.  Eval Bar (Lichess-style tanh)
   ───────────────────────────────────────────── */

function updateEvalBar(score, text) {
    const fill = document.getElementById("eval-bar-fill");
    if (!fill) return;
    let pct = 50 + 50 * Math.tanh(score / 4);
    pct = Math.max(3, Math.min(97, pct));
    fill.style.height = pct + "%";

    const wT = document.getElementById("eval-text-white");
    const bT = document.getElementById("eval-text-black");
    if (score >= 0) {
        if (wT) wT.innerText = text;
        if (bT) bT.innerText = "";
    } else {
        if (bT) bT.innerText = text;
        if (wT) wT.innerText = "";
    }
}
