import chess
import chess.pgn
import io
import sys
from collections import Counter

def get_piece_name(piece):
    if not piece: return "."
    names = {
        chess.PAWN: "Pawn",
        chess.KNIGHT: "Knight",
        chess.BISHOP: "Bishop",
        chess.ROOK: "Rook",
        chess.QUEEN: "Queen",
        chess.KING: "King"
    }
    color = "White" if piece.color == chess.WHITE else "Black"
    return f"{color} {names[piece.piece_type]}"

def get_piece_symbol(piece_type, color):
    symbols = {
        chess.PAWN: "♟" if color == chess.BLACK else "♙",
        chess.KNIGHT: "♞" if color == chess.BLACK else "♘",
        chess.BISHOP: "♝" if color == chess.BLACK else "♗",
        chess.ROOK: "♜" if color == chess.BLACK else "♖",
        chess.QUEEN: "♛" if color == chess.BLACK else "♕",
        chess.KING: "♚" if color == chess.BLACK else "♔"
    }
    return symbols.get(piece_type, "?")

def generate_threat_map(board):
    white_attacks = set()
    black_attacks = set()
    for square in chess.SQUARES:
        if board.is_attacked_by(chess.WHITE, square):
            white_attacks.add(chess.square_name(square))
        if board.is_attacked_by(chess.BLACK, square):
            black_attacks.add(chess.square_name(square))
    return sorted(list(white_attacks)), sorted(list(black_attacks))

def get_captured_pieces(board):
    starting_pieces = {
        chess.WHITE: Counter({chess.PAWN: 8, chess.KNIGHT: 2, chess.BISHOP: 2, chess.ROOK: 2, chess.QUEEN: 1, chess.KING: 1}),
        chess.BLACK: Counter({chess.PAWN: 8, chess.KNIGHT: 2, chess.BISHOP: 2, chess.ROOK: 2, chess.QUEEN: 1, chess.KING: 1})
    }
    current_pieces = {chess.WHITE: Counter(), chess.BLACK: Counter()}
    for square in chess.SQUARES:
        piece = board.piece_at(square)
        if piece:
            current_pieces[piece.color][piece.piece_type] += 1
    captured = {chess.WHITE: [], chess.BLACK: []}
    for color in [chess.WHITE, chess.BLACK]:
        diff = starting_pieces[color] - current_pieces[color]
        for piece_type, count in diff.items():
            symbol = get_piece_symbol(piece_type, color)
            name = {chess.PAWN: "Pawn", chess.KNIGHT: "Knight", chess.BISHOP: "Bishop", chess.ROOK: "Rook", chess.QUEEN: "Queen"}[piece_type]
            for _ in range(count):
                captured[color].append(f"{symbol} {name}")
    return captured

def validate_move_safety(board, move):
    """Checks if a move is a massive blunder (hanging pieces)."""
    if move not in board.legal_moves:
        return False, f"ILLEGAL MOVE: {board.san(move)} is not valid."

    temp_board = board.copy()
    moving_piece = board.piece_at(move.from_square)
    target_piece = board.piece_at(move.to_square)
    
    values = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
    moving_value = values.get(moving_piece.piece_type, 0)
    
    temp_board.push(move)
    
    # Check if piece is attacked by a cheaper piece or undefended
    if temp_board.is_attacked_by(not moving_piece.color, move.to_square):
        is_protected = temp_board.is_attacked_by(moving_piece.color, move.to_square)
        attackers = temp_board.attackers(not moving_piece.color, move.to_square)
        cheapest_attacker_value = min([values.get(temp_board.piece_at(sq).piece_type, 9) for sq in attackers])
        
        if cheapest_attacker_value < moving_value:
             return False, f"BLUNDER: Moving {get_piece_name(moving_piece)} to a square attacked by a cheaper piece ({cheapest_attacker_value} value)."
        if not is_protected:
             return False, f"BLUNDER: Hanging {get_piece_name(moving_piece)} on {chess.square_name(move.to_square)} with no protection!"
    return True, "Safe."

def write_state_files(board, pgn_str):
    """Writes all the game documentation files based on current board state."""
    with open("current_game.pgn", "w", encoding="utf-8") as f:
        f.write(pgn_str)
    
    with open("piece_positions.md", "w", encoding="utf-8") as f:
        f.write("# Active Piece Positions\n\n## White Pieces\n")
        for square in chess.SQUARES:
            piece = board.piece_at(square)
            if piece and piece.color == chess.WHITE: f.write(f"- {get_piece_name(piece)}: {chess.square_name(square)}\n")
        f.write("\n## Black Pieces\n")
        for square in chess.SQUARES:
            piece = board.piece_at(square)
            if piece and piece.color == chess.BLACK: f.write(f"- {get_piece_name(piece)}: {chess.square_name(square)}\n")
    
    w_attacks, b_attacks = generate_threat_map(board)
    with open("threat_map.md", "w", encoding="utf-8") as f:
        f.write("# 🛡️ Tactical Threat Map\n\n## ⚪ SQUARES ATTACKED BY WHITE\n")
        f.write(", ".join(w_attacks) + "\n\n## ⚫ SQUARES ATTACKED BY BLACK\n")
        f.write(", ".join(b_attacks) + "\n\n## 📜 LEGAL MOVES FOR NEXT TURN\n")
        f.write(", ".join([board.san(m) for m in board.legal_moves]) + "\n")

    captured = get_captured_pieces(board)
    with open("captured_pieces.md", "w", encoding="utf-8") as f:
        f.write("# Captured Pieces Tracker\n\n## Taken by White (Black Pieces Gone)\n")
        for p in captured[chess.BLACK]: f.write(f"- {p}\n")
        f.write("\n## Taken by Black (White Pieces Gone)\n")
        for p in captured[chess.WHITE]: f.write(f"- {p}\n")

def sync(pgn_str, proposed_move=None):
    pgn = io.StringIO(pgn_str)
    game = chess.pgn.read_game(pgn)
    if not game: return
    board = game.board()
    for move in game.mainline_moves(): board.push(move)
    
    if proposed_move:
        try:
            move_obj = board.parse_san(proposed_move)
            is_safe, msg = validate_move_safety(board, move_obj)
            if not is_safe:
                print(f"SECURITY_ALERT: {msg}")
                sys.exit(1)
            node = game.end()
            node.add_main_variation(move_obj)
            board.push(move_obj)
            pgn_str = str(game)
            print(f"SUCCESS: {proposed_move} applied.")
        except Exception as e:
            print(f"ERROR: {e}")
            sys.exit(1)
    write_state_files(board, pgn_str)

if __name__ == "__main__":
    import os, argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--move', help='Move to validate/apply')
    parser.add_argument('pgn_file', nargs='?')
    args = parser.parse_args()
    pgn_data = ""
    if args.pgn_file and os.path.exists(args.pgn_file):
        with open(args.pgn_file, "r", encoding="utf-8") as f: pgn_data = f.read()
    elif args.pgn_file: pgn_data = args.pgn_file
    elif os.path.exists("current_game.pgn"):
        with open("current_game.pgn", "r", encoding="utf-8") as f: pgn_data = f.read()
    if pgn_data: sync(pgn_data, proposed_move=args.move)
    else: print("No PGN found.")
