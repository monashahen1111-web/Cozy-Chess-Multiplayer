(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ChessEngine = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Square index: 0-63, sq = rank*8 + file. file 0='a', rank 0='1'.
    // Piece code: 'wP','wN','wB','wR','wQ','wK','bP',...

    function fileOf(sq) { return sq % 8; }
    function rankOf(sq) { return Math.floor(sq / 8); }
    function sqOf(file, rank) { return rank * 8 + file; }
    function inBounds(file, rank) { return file >= 0 && file < 8 && rank >= 0 && rank < 8; }
    function colorOf(piece) { return piece ? piece[0] : null; }
    function typeOf(piece) { return piece ? piece[1] : null; }
    function opponent(color) { return color === 'w' ? 'b' : 'w'; }

    const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    function squareName(sq) { return FILES[fileOf(sq)] + (rankOf(sq) + 1); }
    function parseSquare(name) {
        const file = FILES.indexOf(name[0]);
        const rank = parseInt(name.slice(1), 10) - 1;
        return sqOf(file, rank);
    }

    function createInitialState() {
        const board = new Array(64).fill(null);
        const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
        for (let f = 0; f < 8; f++) {
            board[sqOf(f, 0)] = 'w' + backRank[f];
            board[sqOf(f, 1)] = 'wP';
            board[sqOf(f, 6)] = 'bP';
            board[sqOf(f, 7)] = 'b' + backRank[f];
        }
        return {
            board: board,
            turn: 'w',
            castling: { wK: true, wQ: true, bK: true, bQ: true },
            enPassant: null, // square index a pawn just skipped over, or null
            halfmoveClock: 0,
            fullmoveNumber: 1
        };
    }

    function cloneState(state) {
        return {
            board: state.board.slice(),
            turn: state.turn,
            castling: {
                wK: state.castling.wK, wQ: state.castling.wQ,
                bK: state.castling.bK, bQ: state.castling.bQ
            },
            enPassant: state.enPassant,
            halfmoveClock: state.halfmoveClock,
            fullmoveNumber: state.fullmoveNumber
        };
    }

    const KNIGHT_OFFSETS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
    const KING_OFFSETS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Raw attack check - does `byColor` attack `sq`? Ignores whose turn it is / legality,
    // used only to test king safety, so it can't recurse into legality checking.
    function isSquareAttacked(board, sq, byColor) {
        const f0 = fileOf(sq), r0 = rankOf(sq);

        // Pawn attacks: a byColor pawn attacks `sq` if it sits one diagonal step "backward"
        // relative to its own forward direction.
        const pawnDir = byColor === 'w' ? -1 : 1; // white pawns attack upward, so look one rank below sq
        for (const df of [-1, 1]) {
            const f = f0 + df, r = r0 + pawnDir;
            if (inBounds(f, r)) {
                const p = board[sqOf(f, r)];
                if (p === byColor + 'P') return true;
            }
        }

        for (const [df, dr] of KNIGHT_OFFSETS) {
            const f = f0 + df, r = r0 + dr;
            if (inBounds(f, r) && board[sqOf(f, r)] === byColor + 'N') return true;
        }

        for (const [df, dr] of KING_OFFSETS) {
            const f = f0 + df, r = r0 + dr;
            if (inBounds(f, r) && board[sqOf(f, r)] === byColor + 'K') return true;
        }

        for (const [df, dr] of BISHOP_DIRS) {
            let f = f0 + df, r = r0 + dr;
            while (inBounds(f, r)) {
                const p = board[sqOf(f, r)];
                if (p) {
                    if (colorOf(p) === byColor && (typeOf(p) === 'B' || typeOf(p) === 'Q')) return true;
                    break;
                }
                f += df; r += dr;
            }
        }

        for (const [df, dr] of ROOK_DIRS) {
            let f = f0 + df, r = r0 + dr;
            while (inBounds(f, r)) {
                const p = board[sqOf(f, r)];
                if (p) {
                    if (colorOf(p) === byColor && (typeOf(p) === 'R' || typeOf(p) === 'Q')) return true;
                    break;
                }
                f += df; r += dr;
            }
        }

        return false;
    }

    function findKing(board, color) {
        const target = color + 'K';
        for (let sq = 0; sq < 64; sq++) {
            if (board[sq] === target) return sq;
        }
        return -1;
    }

    function isInCheck(state, color) {
        const kingSq = findKing(state.board, color);
        if (kingSq === -1) return false; // shouldn't happen in a valid game
        return isSquareAttacked(state.board, kingSq, opponent(color));
    }

    // Pseudo-legal moves for the piece on `sq` - obeys piece movement rules and "can't capture
    // your own piece", but does NOT check whether it leaves your own king in check.
    function pseudoLegalMovesForSquare(state, sq) {
        const board = state.board;
        const piece = board[sq];
        if (!piece) return [];
        const color = colorOf(piece), type = typeOf(piece);
        const f0 = fileOf(sq), r0 = rankOf(sq);
        const moves = [];

        function addSlide(dirs) {
            for (const [df, dr] of dirs) {
                let f = f0 + df, r = r0 + dr;
                while (inBounds(f, r)) {
                    const to = sqOf(f, r);
                    const target = board[to];
                    if (!target) {
                        moves.push({ from: sq, to: to });
                    } else {
                        if (colorOf(target) !== color) moves.push({ from: sq, to: to });
                        break;
                    }
                    f += df; r += dr;
                }
            }
        }

        if (type === 'P') {
            const dir = color === 'w' ? 1 : -1;
            const startRank = color === 'w' ? 1 : 6;
            const lastRank = color === 'w' ? 7 : 0;
            const oneF = f0, oneR = r0 + dir;

            if (inBounds(oneF, oneR) && !board[sqOf(oneF, oneR)]) {
                const to = sqOf(oneF, oneR);
                if (rankOf(to) === lastRank) {
                    for (const promo of ['Q', 'R', 'B', 'N']) {
                        moves.push({ from: sq, to: to, promotion: promo });
                    }
                } else {
                    moves.push({ from: sq, to: to });
                }
                // two-square advance
                if (r0 === startRank) {
                    const twoR = r0 + dir * 2;
                    if (!board[sqOf(oneF, twoR)]) {
                        moves.push({ from: sq, to: sqOf(oneF, twoR), doubleStep: true });
                    }
                }
            }

            for (const df of [-1, 1]) {
                const f = f0 + df, r = r0 + dir;
                if (!inBounds(f, r)) continue;
                const to = sqOf(f, r);
                const target = board[to];
                if (target && colorOf(target) !== color) {
                    if (rankOf(to) === lastRank) {
                        for (const promo of ['Q', 'R', 'B', 'N']) {
                            moves.push({ from: sq, to: to, promotion: promo });
                        }
                    } else {
                        moves.push({ from: sq, to: to });
                    }
                } else if (!target && state.enPassant === to) {
                    moves.push({ from: sq, to: to, enPassant: true });
                }
            }
        } else if (type === 'N') {
            for (const [df, dr] of KNIGHT_OFFSETS) {
                const f = f0 + df, r = r0 + dr;
                if (!inBounds(f, r)) continue;
                const to = sqOf(f, r);
                const target = board[to];
                if (!target || colorOf(target) !== color) moves.push({ from: sq, to: to });
            }
        } else if (type === 'B') {
            addSlide(BISHOP_DIRS);
        } else if (type === 'R') {
            addSlide(ROOK_DIRS);
        } else if (type === 'Q') {
            addSlide(BISHOP_DIRS.concat(ROOK_DIRS));
        } else if (type === 'K') {
            for (const [df, dr] of KING_OFFSETS) {
                const f = f0 + df, r = r0 + dr;
                if (!inBounds(f, r)) continue;
                const to = sqOf(f, r);
                const target = board[to];
                if (!target || colorOf(target) !== color) moves.push({ from: sq, to: to });
            }

            // Castling
            const rank = color === 'w' ? 0 : 7;
            if (sq === sqOf(4, rank) && !isSquareAttacked(board, sq, opponent(color))) {
                const kSideRight = color === 'w' ? state.castling.wK : state.castling.bK;
                const qSideRight = color === 'w' ? state.castling.wQ : state.castling.bQ;

                if (kSideRight && !board[sqOf(5, rank)] && !board[sqOf(6, rank)] &&
                    board[sqOf(7, rank)] === color + 'R' &&
                    !isSquareAttacked(board, sqOf(5, rank), opponent(color)) &&
                    !isSquareAttacked(board, sqOf(6, rank), opponent(color))) {
                    moves.push({ from: sq, to: sqOf(6, rank), castle: 'K' });
                }
                if (qSideRight && !board[sqOf(3, rank)] && !board[sqOf(2, rank)] && !board[sqOf(1, rank)] &&
                    board[sqOf(0, rank)] === color + 'R' &&
                    !isSquareAttacked(board, sqOf(3, rank), opponent(color)) &&
                    !isSquareAttacked(board, sqOf(2, rank), opponent(color))) {
                    moves.push({ from: sq, to: sqOf(2, rank), castle: 'Q' });
                }
            }
        }

        return moves;
    }

    function makeMove(state, move) {
        const next = cloneState(state);
        const board = next.board;
        const piece = board[move.from];
        const color = colorOf(piece), type = typeOf(piece);
        const captured = board[move.to];

        let isCaptureOrPawnMove = (type === 'P') || !!captured;

        // En passant capture: the captured pawn is NOT on the destination square.
        if (move.enPassant) {
            const capturedPawnSq = sqOf(fileOf(move.to), rankOf(move.from));
            board[capturedPawnSq] = null;
            isCaptureOrPawnMove = true;
        }

        board[move.to] = move.promotion ? (color + move.promotion) : piece;
        board[move.from] = null;

        // Castling: move the rook too.
        if (move.castle === 'K') {
            const rank = rankOf(move.from);
            board[sqOf(5, rank)] = board[sqOf(7, rank)];
            board[sqOf(7, rank)] = null;
        } else if (move.castle === 'Q') {
            const rank = rankOf(move.from);
            board[sqOf(3, rank)] = board[sqOf(0, rank)];
            board[sqOf(0, rank)] = null;
        }

        // Update castling rights.
        if (type === 'K') {
            if (color === 'w') { next.castling.wK = false; next.castling.wQ = false; }
            else { next.castling.bK = false; next.castling.bQ = false; }
        }
        function clearRookRight(sq) {
            if (sq === sqOf(0, 0)) next.castling.wQ = false;
            else if (sq === sqOf(7, 0)) next.castling.wK = false;
            else if (sq === sqOf(0, 7)) next.castling.bQ = false;
            else if (sq === sqOf(7, 7)) next.castling.bK = false;
        }
        clearRookRight(move.from);
        clearRookRight(move.to);

        // En passant target for the *next* move.
        next.enPassant = move.doubleStep
            ? sqOf(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2)
            : null;

        next.halfmoveClock = isCaptureOrPawnMove ? 0 : state.halfmoveClock + 1;
        if (color === 'b') next.fullmoveNumber += 1;
        next.turn = opponent(color);

        return next;
    }

    function generateLegalMoves(state, colorOverride) {
        const color = colorOverride || state.turn;
        const legal = [];
        for (let sq = 0; sq < 64; sq++) {
            const piece = state.board[sq];
            if (!piece || colorOf(piece) !== color) continue;
            const pseudo = pseudoLegalMovesForSquare(state, sq);
            for (const move of pseudo) {
                const resulting = makeMove(state, move);
                if (!isInCheck(resulting, color)) legal.push(move);
            }
        }
        return legal;
    }

    // Rough "insufficient material" check: K vs K, K+B vs K, K+N vs K.
    function hasInsufficientMaterial(state) {
        const pieces = state.board.filter(p => p);
        if (pieces.length > 3) return false;
        const nonKings = pieces.filter(p => typeOf(p) !== 'K');
        if (nonKings.length === 0) return true;
        if (nonKings.length === 1 && (typeOf(nonKings[0]) === 'B' || typeOf(nonKings[0]) === 'N')) return true;
        return false;
    }

    function getGameStatus(state) {
        const legal = generateLegalMoves(state);
        if (legal.length === 0) {
            if (isInCheck(state, state.turn)) {
                return { status: 'checkmate', winner: opponent(state.turn) };
            }
            return { status: 'stalemate' };
        }
        if (state.halfmoveClock >= 100) return { status: 'draw-fifty-move' };
        if (hasInsufficientMaterial(state)) return { status: 'draw-insufficient-material' };
        return { status: 'ongoing' };
    }

    function perft(state, depth) {
        if (depth === 0) return 1;
        const moves = generateLegalMoves(state);
        if (depth === 1) return moves.length;
        let count = 0;
        for (const move of moves) {
            count += perft(makeMove(state, move), depth - 1);
        }
        return count;
    }

    return {
        createInitialState,
        cloneState,
        generateLegalMoves,
        makeMove,
        isInCheck,
        getGameStatus,
        perft,
        squareName,
        parseSquare,
        colorOf,
        typeOf,
        fileOf,
        rankOf,
        sqOf
    };
});
