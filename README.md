# Cathedral (Ruffle Multiplayer)

This repository contains the original SWF (in `site/`) and a small backend server that lets multiple clients share game state. The SWF uses `XMLSocket` and is hardcoded to connect to `eco.3e.org:9604`.

## HTML/JS version (no Flash)

`site/html/` is a plain HTML/JS/CSS port of the game — no Ruffle or Flash required. It was reconstructed from `cathedral.swf` (vector shapes, layout, sounds, and ActionScript behavior extracted with JPEXS ffdec; see `cathedral.flr.txt` for the original code).

- Open `site/html/index.html` (it works offline/file:// as a local two-hands board, or served over HTTP with the proxy below for multiplayer).
- It speaks the original XMLSocket protocol (null-terminated `<MOTION/>` / `<YOURTURN/>` / `<ALIVE/>` XML) over a WebSocket, defaulting to `ws(s)://<host>/ws` like the Ruffle page — so it interoperates with the SWF running in Ruffle on the same `xmlsocket_server` + `websockify` stack. An HTML player and a Ruffle player can play each other.
- URL parameters: `?name=` and `?opp=` prefill the intro fields; `?ws=ws://host:port` overrides the WebSocket URL (handy for local testing against a bare `websockify`).
- Controls match the original: drag pieces (25px grid snap on drop), SPACE rotates the last-grabbed piece (double-click/double-tap also rotates), `end turn` and `reset` as before.

With the Docker/Caddy setup below, the HTML version is served at `/html/` alongside the Ruffle version at `/`.

## 1) Run the XMLSocket broadcast server

```zsh
./xmlsocket_server.py --host 0.0.0.0 --port 9604
```

Behavior:
- Accepts raw TCP (Flash `XMLSocket`).
- Expects null-terminated XML strings.
- Broadcasts any XML message to all connected clients (including the sender).
- Serves a Flash socket policy file when it receives `<policy-file-request/>`.

If you are testing locally and don't control `eco.3e.org`, you can point `eco.3e.org` to the server with `/etc/hosts` or run the server on the real `eco.3e.org` host.

## 2) Ruffle: desktop vs web

### Ruffle Desktop
Ruffle Desktop can open raw TCP sockets directly. If your server is reachable at `eco.3e.org:9604`, you can just open `site/cathedral.swf` in Ruffle Desktop.

### Ruffle Web (browser)
Browsers cannot open raw TCP sockets, so Ruffle Web must proxy XMLSocket traffic through WebSockets.

1. Start the TCP server (above).
2. Run a WebSocket proxy that forwards to the TCP server (example with `websockify`):

```zsh
websockify 8181 eco.3e.org:9604
```

3. Open `site/index.html` (configured to map `eco.3e.org:9604` to `ws(s)://<host>/ws`).

If your proxy or server is elsewhere, update the `socketProxy` block in `site/index.html`.

## 3) Docker + Caddy (public web hosting)
This repo includes a minimal `docker-compose.yml` and `Caddyfile` to serve the game and proxy XMLSocket traffic.

1. Put the public hostname in `Caddyfile` (default is `eco.3e.org`).
2. Ensure `eco.3e.org` resolves to your server and ports 80/443 are open.
3. Bring it up:

```zsh
docker compose up -d
```

Files served:
- `site/index.html`
- `site/cathedral.swf`

## Notes
- The SWF is hardcoded to connect to `eco.3e.org:9604` (see `cathedral.flr.txt`).
- If you want to change the host/port inside the SWF, you'll need to patch and recompile the SWF.
