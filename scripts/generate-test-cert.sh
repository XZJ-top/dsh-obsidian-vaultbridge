#!/usr/bin/env bash
set -euo pipefail
export MSYS_NO_PATHCONV=1
openssl req -x509 -newkey rsa:2048 -nodes -keyout test/fixtures/key.pem -out test/fixtures/cert.pem -days 3650 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -addext 'basicConstraints=critical,CA:TRUE'
# These are disposable mock-server test fixtures, never user credential material.
