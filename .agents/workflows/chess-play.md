---
description: AI Chess Agent - Tactical Verification Workflow
---

// turbo-all

# ♟️ AI Chess Agent Workflow

## 🧠 Core Principle (READ THIS FIRST)

You are playing as **Black**. You are NOT allowed to:

- Use any external chess engine API, cloud engine, or chess library to calculate moves.
- Suggest any move that is not listed in `threat_map.md` under `LEGAL MOVES FOR NEXT TURN`.
- Skip reading the source-of-truth files before responding.

You MUST base every move decision ONLY on the following allowed files:

- `piece_positions.md` — Current piece locations for both sides.
- `threat_map.md` — All attacked squares and your legal moves this turn.
- `current_game.pgn` — Full game history in PGN notation.
- `captured_pieces.md` — Material balance overview.

---

## 📋 Step-by-Step Workflow

### When the USER sends their move (as a full PGN string):

// turbo

1. **Update `current_game.pgn`**: Replace the full PGN line (line 9) with the user's new updated PGN string exactly as provided.

// turbo 2. **Run `sync_game.py`** to regenerate all state files:

```
python sync_game.py
```

This auto-updates: `piece_positions.md`, `threat_map.md`, `captured_pieces.md`.

3. **Read the updated files** before deciding your move:
   - Read `piece_positions.md` to understand where every piece is.
   - Read `threat_map.md` — your move MUST come from the `LEGAL MOVES FOR NEXT TURN` list.
   - Consider the `captured_pieces.md` to understand material balance.

4. **Choose your move** based ONLY on the legal moves list. Apply chess strategy:
   - Avoid hanging pieces (moving to attacked squares unprotected).
   - Prefer moves that create counter-threats or improve piece activity.
   - Look for checks, captures, or pawn advances that gain tempo.

5. **Update `current_game.pgn`**: Append your chosen move to the PGN.

// turbo 6. **Run `sync_game.py` again** to synchronize state after your move.

7. **Respond to the user** with ONLY your move in SAN notation (e.g., `44... Rf2+`). No lengthy explanations unless asked.

---

## ⛔ Strict Rules (Violations = Hallucination)

| ❌ FORBIDDEN                    | ✅ REQUIRED                                  |
| ------------------------------- | -------------------------------------------- |
| Suggesting an illegal move      | Only choose from `LEGAL MOVES FOR NEXT TURN` |
| Using Stockfish/cloud engines   | Use only the provided markdown files         |
| Imagining piece locations       | Always read `piece_positions.md` first       |
| Writing moves not in SAN format | Use standard SAN (e.g., `Rxc3+`, `Kh8`)      |
| Skipping `sync_game.py`         | Always run it after each move                |

---

## 📁 Key Files Reference

| File                 | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `current_game.pgn`   | Full game record — always update this    |
| `piece_positions.md` | Ground truth for all piece locations     |
| `threat_map.md`      | Attacked squares + legal moves list      |
| `captured_pieces.md` | Pieces taken by each side                |
| `sync_game.py`       | Regenerates all the above files from PGN |

---

## 🎯 Game End Conditions

- If `game.in_checkmate()` → Record result as `1-0` or `0-1` in PGN header.
- If `game.in_draw()` or mutual agreement → Record result as `1/2-1/2`.
- Always update the `[Result "..."]` tag in `current_game.pgn`.
