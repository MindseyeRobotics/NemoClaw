#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# gateway-relay.py — TCP relay from 127.0.0.1:LOCAL_PORT to REMOTE_HOST:REMOTE_PORT.
#
# The openshell forward SSH tunnel only supports SFTP file mounting and does not
# pass raw TCP channel data. This relay bridges the gap by connecting directly
# to the k3s container's docker network IP where kubectl port-forward has bound
# the gateway port.
#
# Usage: python3 gateway-relay.py [local_port] [remote_host] [remote_port]
# Defaults: 18789  172.18.0.2  18789

import socket
import threading
import sys
import os
import signal
import time

LOCAL_HOST = "127.0.0.1"
LOCAL_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18789
REMOTE_HOST = sys.argv[2] if len(sys.argv) > 2 else "172.18.0.2"
REMOTE_PORT = int(sys.argv[3]) if len(sys.argv) > 3 else 18789


def relay(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try:
            src.close()
        except Exception:
            pass
        try:
            dst.close()
        except Exception:
            pass


def handle(conn):
    try:
        remote = socket.create_connection((REMOTE_HOST, REMOTE_PORT), timeout=10)
        t1 = threading.Thread(target=relay, args=(conn, remote), daemon=True)
        t2 = threading.Thread(target=relay, args=(remote, conn), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
    except Exception as e:
        sys.stderr.write(f"[gateway-relay] connection error: {e}\n")
        sys.stderr.flush()
        try:
            conn.close()
        except Exception:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((LOCAL_HOST, LOCAL_PORT))
    except OSError as e:
        sys.stderr.write(f"[gateway-relay] bind failed on {LOCAL_HOST}:{LOCAL_PORT}: {e}\n")
        sys.exit(1)
    srv.listen(128)

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))

    sys.stdout.write(
        f"[gateway-relay] {LOCAL_HOST}:{LOCAL_PORT} -> {REMOTE_HOST}:{REMOTE_PORT}\n"
    )
    sys.stdout.flush()

    while True:
        try:
            conn, _ = srv.accept()
            threading.Thread(target=handle, args=(conn,), daemon=True).start()
        except Exception:
            break


if __name__ == "__main__":
    main()
