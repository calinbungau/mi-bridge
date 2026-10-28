#!/usr/bin/env bash
# Pasul 2 – după ce ai primit login-ul de la Eurowag:
#   bash <(curl -fsSL https://raw.githubusercontent.com/calinbungau/mi-bridge/main/start.sh)
set -euo pipefail
cd /opt/mi-bridge

if grep -q '<<< LOGIN PRIMIT' config.yaml; then
  read -r -p "Login-ul primit de la Eurowag (Multi-Interface): " L < /dev/tty
  sed -i "s#login: \"<<< LOGIN PRIMIT DE LA EUROWAG >>>\"#login: \"$L\"#" config.yaml
fi

echo ">>> test conexiune la Eurowag (testEcho + catalog), 15 secunde..."
timeout 40 node mi-bridge.js -c config.yaml --echo --once-catalogue || true

echo
echo ">>> pornire permanentă cu pm2"
pm2 start ecosystem.config.js >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
echo "Gata. Loguri live:  pm2 logs mi-bridge     (ieși cu Ctrl+C)"
echo "Repornire după ce modifici config.yaml:  pm2 restart mi-bridge"
pm2 logs mi-bridge --lines 20 --nostream
