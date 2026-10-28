# mi-bridge — Traccar → Eurowag/Dispecer.sk Multi-Interface (VIMAREK)

Node.js, rulat cu pm2. Implementează *Multi-Interface Technical specification v4.0* (dispecer.sk):
luăm pozițiile vehiculelor VIMAREK din Traccar-ul nostru și le trimitem în Transport Manager (TM).

## Protocolul pe scurt

| Pas | Cine | Ce |
|---|---|---|
| 1 | noi | SSH2 la `217.73.17.143:722`, subsystem `linterface`, autentificare cu cheie fără parolă. Conexiune **permanentă**; la cădere așteptăm 60 s și reconectăm. |
| 2 | ambii | `<?xml ...?><stream version="4.0">` — nu se închide niciodată; fiecare element de nivel 1 se închide și se procesează imediat. |
| 3 | MI → noi | `<lcenterList>` — centrele logistice asignate nouă. |
| 4 | noi → MI | `<provider>` (contact) + `<catalogue>` (transportatori, vehicule, remorci, șoferi, relații). Retrimis la fiecare oră / la schimbare. |
| 5 | MI → noi | `<onlineRegime>` — ce vehicule sunt **în transport** (`online="1"`). Doar pentru ele trimitem date. |
| 6 | noi → MI | `<data>` cu `<gps>` (lat/lng/time UTC) și `<state>` (moto = contact, ușă, panic). În mers ≤5 min; oprit `<state>` ≤15 min; timpi strict crescători. |
| 7 | MI → noi | `<dispatcherMessageData>` — mesaje de la dispecer (doar dacă vehiculul are `communication=1`). Momentan le logăm. |

## Ce face `mi-bridge.js`
- `MIConnection` — `ssh2` → `conn.subsys('linterface')`, scrie header-ul de stream, parsează incremental cu `sax` (stream-ul nu se închide niciodată), reconectare la 60 s.
- `buildCatalogue()` — din `config.yaml` + `lcenterList` primit de la MI (pentru `<relations>`).
- `Bridge.pollOnce()` — pentru fiecare vid online: `GET /api/positions?deviceId&from&to` din Traccar, doar punctele mai noi decât ultimul trimis, `moto` din atributul `ignition` (fallback `motion`, apoi viteză), filtru opriri scurte (`stop_filter_sec`), heartbeat `<state>` la 15 min când stă.
- La `online 0→1` trimite imediat ultima poziție + stare (cerință din spec).

## Instalare pe server (Ubuntu/Debian)

```bash
# Node 18+ și pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm i -g pm2

# aplicația
sudo mkdir -p /opt/mi-bridge && sudo chown $USER /opt/mi-bridge
cp -r mi-bridge.js ecosystem.config.js package.json config.example.yaml /opt/mi-bridge/
cd /opt/mi-bridge && npm install --omit=dev
cp config.example.yaml config.yaml

# cheie SSH pentru MI (FĂRĂ parolă) — publica se trimite la Aldobec / obchod@dispecer.sk, primești login-ul
ssh-keygen -t rsa -b 4096 -N "" -C "enovgps-mi-bridge" -f /opt/mi-bridge/mi_id_rsa
cat /opt/mi-bridge/mi_id_rsa.pub
chmod 600 /opt/mi-bridge/mi_id_rsa /opt/mi-bridge/config.yaml
```

Editează `config.yaml`: `mi.login`, `mi.private_key: /opt/mi-bridge/mi_id_rsa`, `traccar.url` + `token`,
vehiculele VIMAREK (`vid` = deviceId din Traccar, `vrn` = nr. înmatriculare — obligatoriu, `vin`).

```bash
npm run dry               # fără SSH: vezi XML-ul (provider + catalog) care s-ar trimite
npm run test-connection   # conexiune reală + <testEcho> + catalog, apoi iese (contul e „testing” în faza asta)

pm2 start ecosystem.config.js
pm2 logs mi-bridge
pm2 save && pm2 startup   # pornire la boot (rulează comanda pe care o afișează)
```

Firewall: ieșire TCP spre `217.73.17.143:722` și acces HTTP(S) la Traccar.
**O singură instanță** per login MI (`instances: 1` în ecosystem) — altfel ai două stream-uri pe același cont.

## De verificat cu Eurowag înainte de producție
- schema XSD + exemplele („XML schema and examples”, livrate cu PDF-ul, nu sunt publice) — validare opțională.
- `vid` = deviceId Traccar sau IMEI? (se schimbă doar în config).
- formatul timpului: spec arată `2015-10-01T22:40:22` (UTC, fără `Z`) — așa trimitem.

## Limitări / TODO
- Mesaje dispecer → vehicul: doar logate (VIMAREK n-are consolă de comunicare).
- `<driverData>` / `<trailerData>`: structura e în catalog, dar nu trimitem evenimente (se adaugă dacă Traccar are `driverUniqueId` pe poziții).
- Rutele (`<route>` polyline) de la TM nu sunt trimise în vehicul.
