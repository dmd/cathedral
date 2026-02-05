#!/usr/bin/env python3
import argparse
import asyncio
import logging
import signal
from typing import Set

POLICY_TEMPLATE = """<?xml version=\"1.0\"?>
<!DOCTYPE cross-domain-policy SYSTEM \"http://www.macromedia.com/xml/dtds/cross-domain-policy.dtd\">
<cross-domain-policy>
  <allow-access-from domain=\"{domain}\" to-ports=\"{ports}\" />
</cross-domain-policy>"""


class BroadcastServer:
    def __init__(self, policy_domain: str, policy_ports: str) -> None:
        self._clients: Set[asyncio.StreamWriter] = set()
        self._policy_domain = policy_domain
        self._policy_ports = policy_ports

    async def handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        logging.info("client connected: %s", peer)
        self._clients.add(writer)
        buffer = bytearray()

        try:
            while True:
                data = await reader.read(4096)
                if not data:
                    break
                buffer.extend(data)

                while True:
                    try:
                        idx = buffer.index(0)
                    except ValueError:
                        break

                    raw = bytes(buffer[:idx])
                    del buffer[: idx + 1]
                    if not raw:
                        continue

                    text = raw.decode("utf-8", errors="ignore").strip()
                    if text == "<policy-file-request/>":
                        policy = POLICY_TEMPLATE.format(
                            domain=self._policy_domain,
                            ports=self._policy_ports,
                        ).encode("utf-8")
                        writer.write(policy + b"\x00")
                        await writer.drain()
                        logging.info("policy file served to %s", peer)
                        self._clients.discard(writer)
                        writer.close()
                        try:
                            await writer.wait_closed()
                        except ConnectionError:
                            pass
                        return

                    await self._broadcast(raw + b"\x00")
        except ConnectionError:
            pass
        finally:
            self._clients.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except ConnectionError:
                pass
            logging.info("client disconnected: %s", peer)

    async def _broadcast(self, payload: bytes) -> None:
        if not self._clients:
            return
        dead = []
        for client in self._clients:
            try:
                client.write(payload)
            except ConnectionError:
                dead.append(client)
        if dead:
            for client in dead:
                self._clients.discard(client)
        await asyncio.gather(
            *(client.drain() for client in self._clients),
            return_exceptions=True,
        )


async def run_server(host: str, port: int, policy_domain: str, policy_ports: str) -> None:
    server = BroadcastServer(policy_domain=policy_domain, policy_ports=policy_ports)
    server_obj = await asyncio.start_server(server.handle_client, host, port)
    addrs = ", ".join(str(sock.getsockname()) for sock in server_obj.sockets or [])
    logging.info("listening on %s", addrs)
    async with server_obj:
        await server_obj.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="XMLSocket broadcast server (null-terminated XML)."
    )
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=9604, help="Port to bind (default: 9604)")
    parser.add_argument(
        "--policy-domain",
        default="*",
        help="Domain for socket policy file (default: *)",
    )
    parser.add_argument(
        "--policy-ports",
        default="9604",
        help="Ports for socket policy file (default: 9604)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, loop.stop)
        except NotImplementedError:
            pass

    try:
        loop.run_until_complete(
            run_server(args.host, args.port, args.policy_domain, args.policy_ports)
        )
    except KeyboardInterrupt:
        pass
    finally:
        loop.stop()
        loop.close()


if __name__ == "__main__":
    main()
