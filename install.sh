#!/usr/bin/env bash
# Instalare mi-bridge pe Ubuntu (ca root):
#   bash <(curl -fsSL https://raw.githubusercontent.com/calinbungau/mi-bridge/main/install.sh)
set -euo pipefail
BASE_URL="${BASE_URL:-https://raw.githubusercontent.com/calinbungau/mi-bridge/main}"
APP=/opt/mi-bridge

echo ">>> [1/4] Node.js + pm2"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null 2>&1 || npm i -g pm2 >/dev/null

echo ">>> [2/4] fișiere în $APP"
mkdir -p "$APP/logs" && cd "$APP"
for f in mi-bridge.js package.json ecosystem.config.js config.example.yaml README.md; do
  curl -fsSL "$BASE_URL/$f" -o "$f"
done
node --check mi-bridge.js
npm install --omit=dev --silent

if [ ! -f config.yaml ]; then
  cp config.example.yaml config.yaml
  echo
  echo ">>> Datele de Traccar (userul trebuie să vadă camioanele VIMAREK):"
  read -r -p "  URL Traccar [https://gps.bngtracking.ro]: " TURL < /dev/tty; TURL="${TURL:-https://gps.bngtracking.ro}"
  read -r -p "  User Traccar: " TUSER < /dev/tty
  read -r -s -p "  Parola Traccar: " TPASS < /dev/tty; echo
  python3 - "$TURL" "$TUSER" "$TPASS" <<'PY'
import sys,re
url,user,pw=sys.argv[1:4]
s=open('config.yaml',encoding='utf-8').read()
s=re.sub(r'url: "[^"]*"', 'url: "%s"'%url, s, count=1)
s=re.sub(r'user: "[^"]*"', 'user: "%s"'%user.replace('"','\\"'), s, count=1)
s=re.sub(r'password: "[^"]*"', 'password: "%s"'%pw.replace('"','\\"'), s, count=1)
open('config.yaml','w',encoding='utf-8').write(s)
PY
fi

echo ">>> [3/4] cheie SSH pentru Eurowag"
[ -f mi_id_rsa ] || ssh-keygen -t rsa -b 4096 -N "" -C "bngtracking-mi-bridge" -f mi_id_rsa -q
chmod 600 mi_id_rsa config.yaml

echo ">>> [4/4] test citire Traccar"
node -e '
const y=require("js-yaml"),a=require("axios");const c=y.load(require("fs").readFileSync("config.yaml","utf8"));
a.get(c.traccar.url.replace(/\/$/,"")+"/api/devices",{auth:{username:c.traccar.user,password:c.traccar.password},timeout:15000})
 .then(r=>{const ids=new Set(r.data.map(d=>String(d.uniqueId)));const ok=c.vehicles.filter(v=>ids.has(String(v.imei)));
   console.log("  Traccar OK – "+ok.length+"/"+c.vehicles.length+" camioane VIMAREK găsite");
   c.vehicles.filter(v=>!ids.has(String(v.imei))).forEach(v=>console.log("  LIPSĂ în Traccar: "+v.vrn+" ("+v.imei+")"));})
 .catch(e=>console.log("  !!! Traccar NU răspunde / user-parolă greșite: "+e.message));
'

echo
echo "=================================================================="
echo " Trimite pe mail la obchod@dispecer.sk cheia PUBLICĂ de mai jos"
echo " (toată linia) și cere login-ul pentru Multi-Interface:"
echo "=================================================================="
cat mi_id_rsa.pub
echo "=================================================================="
echo
echo "Când primești login-ul de la Eurowag, rulezi:"
echo "  bash <(curl -fsSL $BASE_URL/start.sh)"
