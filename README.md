# Cathedral (Ruffle Multiplayer)

This repository contains the original SWF (in `site/`) and a small backend server that lets multiple clients share game state. The SWF uses `XMLSocket` and is hardcoded to connect to `eco.3e.org:9604`.

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
