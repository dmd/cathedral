# Cathedral (HTML/JS Multiplayer)

A two-player online version of the Cathedral board game, originally written in Flash in 2001. `site/` is a plain HTML/JS/CSS port of the game — no Flash or Ruffle required. It was reconstructed from `cathedral.swf` (vector shapes, layout, sounds, and ActionScript behavior extracted with JPEXS ffdec; see `cathedral.flr.txt` for the original ActionScript).

- Open `site/index.html` (it works offline/file:// as a local two-hands board, or served over HTTP with the proxy below for multiplayer).
- It speaks the original XMLSocket protocol (null-terminated `<MOTION/>` / `<YOURTURN/>` / `<ALIVE/>` XML) over a WebSocket, defaulting to `ws(s)://<host>/ws` — wire-compatible with the original SWF, so an HTML player and the SWF running in Ruffle (or Flash) can play each other against the same server.
- URL parameters: `?name=` and `?opp=` prefill the intro fields; `?ws=ws://host:port` overrides the WebSocket URL (handy for local testing against a bare `websockify`).
- Controls match the original: drag pieces (25px grid snap on drop), SPACE rotates the last-grabbed piece (double-click/double-tap also rotates), `end turn` and `reset` as before.
- **Enforce the rules** (intro checkbox, on by default): when both players' clients
  have it on (and both entered distinct names), person-vs-person games are
  rule-enforced by the same engine as the computer mode — assigned colors (the
  lexicographically first name plays green and opens game 1 with the cathedral),
  real turns, legal placements only, territory shading, captures, automatic
  passes, and scoring; `reset` starts the next game with duties swapped. The two
  clients negotiate via a `rules="1"` attribute on their ALIVE keepalives and run
  the engine in lockstep (placements travel as `MOTION` with `commit="1"`). If
  the opponent isn't enforcing — toggle off, or the original SWF in Ruffle —
  play gracefully falls back to the classic free-form tabletop.

## Playing against the computer

The intro screen also offers **Play vs. Computer** (or open `?ai=1`). Unlike the
network mode — which, like the original SWF, is a free-form shared tabletop —
the computer mode enforces the full rules from `rules.html` via `site/engine.js`:

- legal placement only (on the grid, no overlaps, not in enemy territory; illegal drops bounce back);
- one player places the cathedral to open the game, the other moves first (the duty alternates each game via `reset`);
- wall-to-wall enclosure claims territory (corner-to-corner contact leaks, per the official notes), shown as tinted squares;
- enclosing exactly one enemy building captures it (it returns to its owner's hand); a captured cathedral is gone for good;
- no claims on a player's first building move; passes are automatic; the game ends when neither side can move, and the fewest unplaced squares wins.

The AI evaluates every legal placement (territory, captures, building size,
space control, centrality) and checks the opponent's best reply for each of its
top candidates. `tests/engine-test.js` (run with `node`) covers the enclosure /
capture rules and plays AI-vs-AI soak games.

The original `cathedral.swf` and `cathedral.fla` are kept in the repo for reference; the SWF is hardcoded to connect to `eco.3e.org:9604` and still works in Ruffle Desktop against the server below.

## 1) Run the XMLSocket broadcast server

```zsh
./xmlsocket_server.py --host 0.0.0.0 --port 9604
```

Behavior:
- Accepts raw TCP (Flash `XMLSocket`).
- Expects null-terminated XML strings.
- Broadcasts any XML message to all connected clients (including the sender).
- Serves a Flash socket policy file when it receives `<policy-file-request/>`.

## 2) WebSocket proxy

Browsers cannot open raw TCP sockets, so the web client proxies the XMLSocket traffic through WebSockets:

```zsh
websockify 8181 127.0.0.1:9604
```

The web client connects to `ws(s)://<host>/ws`, which your web server should proxy to websockify (see `Caddyfile`).

## 3) Docker + Caddy (public web hosting)
This repo includes a minimal `docker-compose.yml` (xmlsocket server + websockify) and a `Caddyfile` snippet to serve the game and proxy the WebSocket traffic.

```zsh
docker compose up -d
```

Files served from `site/`: `index.html`, `style.css`, `game.js`, `data.js`, `assets/`, plus `rules.html`.

## Local testing

```zsh
./xmlsocket_server.py --host 127.0.0.1 --port 9604 &
websockify 8181 127.0.0.1:9604 &
cd site && python3 -m http.server 8765
```

Then open two tabs:
- `http://localhost:8765/?name=alice&opp=bob&ws=ws://localhost:8181`
- `http://localhost:8765/?name=bob&opp=alice&ws=ws://localhost:8181`
