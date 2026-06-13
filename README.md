# Cathedral (HTML/JS)

A two-player version of the **Cathedral** board game: play the built-in computer
opponent, or play a friend online. `site/` is a self-contained HTML/JS/CSS app —
no build step, no dependencies, no plugins.

The game was originally written in Flash in 2001. This is a from-scratch
HTML/JS reconstruction (the piece geometry, layout, and sounds were extracted
from the original `.swf` with JPEXS ffdec). The original Flash sources and the
`.swf` are no longer in the working tree but remain in the git history if you
ever want them.

## Playing

Open `site/index.html` (works offline for the computer game; multiplayer needs
the relay server, see below). The intro screen offers two modes — **both fully
rules-enforced** by `site/engine.js`:

- **Play vs. computer** (or open `?ai=1`): face the built-in AI. See
  [`engine.md`](engine.md) for how it works.
- **Play a friend**: two browsers play over a WebSocket relay. Each player
  enters their own name and the other's name (whatever you type is canonicalized
  identically on both ends — uppercased, letters/digits/spaces — so "Anna" and
  "anna!" still match). The lexicographically first name plays **blue** and
  places the cathedral to open game 1; duties swap each game on **reset**.

### Rules in brief
- One player places the **cathedral** to open the game; the other builds first,
  then players alternate.
- A legal drop is *tentative* — move it, rotate it, swap pieces, or take it back;
  **end turn** commits it. Illegal drops bounce back.
- Enclosing an empty region wall-to-wall (your buildings + the board edge) claims
  it as **territory** (corner-to-corner contact leaks, per the official notes),
  shown as tinted squares. You can't build on the opponent's territory.
- Enclosing **exactly one** enemy building captures it (it returns to its owner's
  hand); a captured cathedral is gone for good. Two or more enemy buildings: no
  claim.
- No claims on a player's first building move. A player with no legal move passes
  automatically; when both pass, the game ends and the **fewest unplaced squares
  wins**.

Full rules: `site/rules.html`.

### Controls
- **Drag** a piece onto the board (snaps to the grid on drop).
- **Rotate** the last-grabbed piece with the on-screen ↻ button, a
  double-click/double-tap, or **SPACE**.
- **end turn** commits a placement; **reset** starts a new game.
- The stage scales to the window and turns 90° on portrait screens, so it's
  playable on phones.
- Desktop: press **`m`** for a copy-pasteable list of the moves so far (in the
  game's move notation; it round-trips through `ENGINE.replay`).

### URL parameters
- `?ai=1` — go straight to the computer game.
- `?name=` and `?opp=` — prefill the friend-game name fields.
- `?ws=ws://host:port` — override the WebSocket URL (handy for local testing).

## Multiplayer plumbing

Friend games exchange **committed moves in notation** over a dumb broadcast
relay; both clients run the same engine in lockstep, so territory, captures, and
passes are derived identically on each side (only the move itself crosses the
wire). The browser talks WebSocket; a small proxy bridges that to the relay's
TCP socket.

### 1) Broadcast relay

```sh
./xmlsocket_server.py --host 0.0.0.0 --port 9604
```

It accepts null-terminated XML frames over TCP and rebroadcasts each frame to all
connected clients (including the sender). That's the whole job — it never parses
the game.

### 2) WebSocket proxy

Browsers can't open raw TCP, so the client connects over WebSocket (default
`ws(s)://<host>/ws`) and a proxy bridges it to the relay:

```sh
websockify 8181 127.0.0.1:9604
```

Your web server should proxy `/ws` to websockify (see `Caddyfile`).

### 3) Docker + Caddy (hosting)

A minimal `docker-compose.yml` runs the relay + websockify; the `Caddyfile`
shows a full example (it serves the game and proxies `/ws` to websockify),
mirroring the live `eco.3e.org` setup.

```sh
docker compose up -d
```

Served from `site/`: `index.html`, `style.css`, `game.js`, `engine.js`,
`data.js`, `assets/`, and `rules.html`.

## Local testing

```sh
./xmlsocket_server.py --host 127.0.0.1 --port 9604 &
websockify 8181 127.0.0.1:9604 &
cd site && python3 -m http.server 8765
```

Then open two tabs:
- `http://localhost:8765/?name=alice&opp=bob&ws=ws://localhost:8181`
- `http://localhost:8765/?name=bob&opp=alice&ws=ws://localhost:8181`

## Development

Everything in `site/` is plain files — edit and reload. The engine and rules are
pure logic (no DOM) and have a headless test suite:

```sh
node tests/engine-test.js     # rules + AI soak
node tests/notation-test.js   # move notation round-trip + replay
node tests/netsync-test.js    # network lockstep (two simulated clients)
```

See [`engine.md`](engine.md) for the AI/engine design, the move notation, the
network protocol, and notes on what's been tried.
