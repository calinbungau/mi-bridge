#!/usr/bin/env node
/**
 * Traccar -> Eurowag/Dispecer.sk Multi-Interface (MI) bridge  (spec v4.0)
 *
 *  - permanent SSH2 connection to MI, subsystem `linterface`
 *  - bidirectional XML stream: <stream version="4.0"> never closed
 *  - we send   : <provider>, <catalogue>, <data>, <testEcho>, <request cmd="getCatalogue"/>
 *  - MI sends  : <lcenterList>, <onlineRegime>, <dispatcherMessageData>, <testEcho>
 *  - positions / states come from Traccar REST (/api/positions)
 *  - only vehicles flagged online="1" by MI are streamed
 *
 *  node mi-bridge.js -c config.yaml [--dry-run] [--once-catalogue] [--echo] [-v]
 */
'use strict';

const fs = require('fs');
const { Client } = require('ssh2');
const sax = require('sax');
const yaml = require('js-yaml');
const axios = require('axios');

// ----------------------------------------------------------------- args / log
const argv = process.argv.slice(2);
const opt = (f) => argv.includes(f);
const cfgPath = argv.includes('-c') ? argv[argv.indexOf('-c') + 1] : (process.env.MI_CONFIG || 'config.yaml');
const DRY = opt('--dry-run'), ONCE = opt('--once-catalogue'), ECHO = opt('--echo'), VERBOSE = opt('-v');

const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO ', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN ', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
  debug: (...a) => { if (VERBOSE) console.log(new Date().toISOString(), 'DEBUG', ...a); },
};

const STREAM_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<stream version="4.0">\n';

// ----------------------------------------------------------------- utils
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const qa = (s) => '"' + String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') + '"';
/** attributes string, skipping null/undefined */
const A = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => ` ${k}=${qa(v)}`).join('');
/** xs:dateTime in UTC without offset – same as examples in spec (2015-10-01T22:40:22) */
const utcIso = (d) => new Date(d).toISOString().slice(0, 19);
const isTrue = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'True';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------- config
function loadConfig(path) {
  const raw = yaml.load(fs.readFileSync(path, 'utf8'));
  const cfg = {
    raw,
    mi: raw.mi,
    traccar: raw.traccar,
    provider: raw.provider || null,
    subcontractors: raw.subcontractors || [],
    lcenters: raw.lcenters || [],
    trailers: raw.trailers || [],
    drivers: raw.drivers || [],
    pollInterval: (raw.poll_interval_sec ?? 60) * 1000,
    standingStateInterval: (raw.standing_state_interval_sec ?? 900) * 1000,
    catalogueInterval: (raw.catalogue_interval_sec ?? 3600) * 1000,
    stopFilterSec: raw.stop_filter_sec ?? 120,
    vehicles: new Map(),
  };
  for (const v of raw.vehicles || []) {
    if (!v.vrn) throw new Error(`vehicle ${v.vid || v.imei}: vrn (registration number) is mandatory`);
    const vid = String(v.vid ?? v.imei ?? v.traccar_device_id);
    cfg.vehicles.set(vid, {
      vid,
      vrn: v.vrn,
      vin: v.vin || '',
      imei: v.imei ? String(v.imei) : null,
      traccarDeviceId: v.traccar_device_id != null ? Number(v.traccar_device_id) : null,   // resolved from imei at startup if null
      isTrailer: Number(v.is_trailer ?? 0),
      doorSensor: Number(v.door_sensor ?? 0),
      doorLock: Number(v.door_lock ?? 0),
      panicButton: Number(v.panic_button ?? 0),
      communication: Number(v.communication ?? 0),
      temperatureSensors: v.temperature_sensors || [],
      maxSendInterval: Number(v.max_send_interval ?? 60),
      onlineMotoOff: Number(v.online_moto_off ?? 1),
      online24x7: Number(v.online_24x7 ?? 1),
      gpsDensity: Number(v.gps_density ?? 10),
      ignitionAttr: v.ignition_attr || 'ignition',
      doorAttr: v.door_attr || null,
      doorLockAttr: v.door_lock_attr || null,
      panicAttr: v.panic_attr || null,
    });
  }
  return cfg;
}

// ----------------------------------------------------------------- Traccar
class Traccar {
  constructor(c) {
    this.http = axios.create({
      baseURL: c.url.replace(/\/$/, ''),
      timeout: (c.timeout_sec ?? 20) * 1000,
      headers: c.token ? { Authorization: `Bearer ${c.token}` } : {},
      auth: c.token ? undefined : { username: c.user, password: c.password },
    });
  }
  async devices() {
    const { data } = await this.http.get('/api/devices');
    return data;
  }
  async latestPositions() {
    const { data } = await this.http.get('/api/positions');
    return new Map(data.map((p) => [p.deviceId, p]));
  }
  async positionsBetween(deviceId, from, to) {
    const { data } = await this.http.get('/api/positions', {
      params: { deviceId, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    });
    return data.sort((a, b) => new Date(a.fixTime) - new Date(b.fixTime));
  }
}

// ----------------------------------------------------------------- XML builders
function contactXml(c) {
  if (!c) return '';
  return `<contact><is24x7>${Number(c.is24x7 ?? 0)}</is24x7><name>${esc(c.name)}</name><telnum>${esc(c.telnum)}</telnum><email>${esc(c.email)}</email></contact>`;
}

function buildProvider(p) {
  return `<provider><name>${esc(p.name)}</name>`
    + (p.additional_name ? `<additionalName>${esc(p.additional_name)}</additionalName>` : '')
    + contactXml(p.contact) + '</provider>';
}

function buildCatalogue(cfg, lcenters) {
  let x = '<catalogue><subcontractorList>';
  for (const s of cfg.subcontractors) {
    x += `<subcontractorInfo${A({ name: s.name })}><additionalSubcontractorInfo${A({ vat: s.vat })}/>${contactXml(s.contact)}</subcontractorInfo>`;
  }
  x += '</subcontractorList><vehicleList>';
  for (const v of cfg.vehicles.values()) {
    x += `<vehicleInfo${A({ vid: v.vid, vrn: v.vrn, isTrailer: v.isTrailer })}>`
      + `<monitoringParams${A({ maxSendDataInterval: v.maxSendInterval, isOnlineMotoOff: v.onlineMotoOff, isOnline24x7: v.online24x7, gpsDensity: v.gpsDensity })}/>`
      + `<additionalVehicleInfo${A({ vin: v.vin, temperatureSensors: v.temperatureSensors.length ? 1 : 0, doorSensor: v.doorSensor, doorLock: v.doorLock, panicButton: v.panicButton, communication: v.communication })}/>`;
    if (v.temperatureSensors.length) {
      x += '<temperatureSensorList>' + v.temperatureSensors.map((t) => `<temperatureSensor${A({ tsid: t.tsid, name: t.name, position: t.position })}/>`).join('') + '</temperatureSensorList>';
    }
    x += '</vehicleInfo>';
  }
  x += '</vehicleList><trailerList>';
  for (const t of cfg.trailers) x += `<trailerInfo${A({ tid: t.tid, vrn: t.vrn })}><additionalTrailerInfo${A({ vin: t.vin || '' })}/></trailerInfo>`;
  x += '</trailerList><driverList>';
  for (const d of cfg.drivers) x += `<driverInfo${A({ did: d.did, name: d.name, surname: d.surname })}><additionalDriverInfo${A({ telnum: d.telnum || '', driverCard: d.driver_card || '' })}/></driverInfo>`;
  x += '</driverList><relations>';
  for (const lc of lcenters) {
    x += `<lcenter${A({ name: lc })}>`;
    for (const s of cfg.subcontractors) {
      if (s.lcenters && !s.lcenters.includes(lc)) continue;
      const vids = s.vehicles || [...cfg.vehicles.keys()];
      const tids = s.trailers || cfg.trailers.map((t) => t.tid);
      const dids = s.drivers || cfg.drivers.map((d) => d.did);
      x += `<subcontractor${A({ name: s.name })}>`;
      if (vids.length) x += '<vehicles>' + vids.map((v) => `<vid>${esc(v)}</vid>`).join('') + '</vehicles>';
      if (tids.length) x += '<trailers>' + tids.map((v) => `<tid>${esc(v)}</tid>`).join('') + '</trailers>';
      if (dids.length) x += '<drivers>' + dids.map((v) => `<did>${esc(v)}</did>`).join('') + '</drivers>';
      x += '</subcontractor>';
    }
    x += '</lcenter>';
  }
  return x + '</relations></catalogue>';
}

// ----------------------------------------------------------------- incoming XML stream parser
/** Builds a tiny DOM for each top-level child of <stream> and calls onElement(node). */
function makeStreamParser(onElement) {
  const parser = sax.parser(false, { lowercase: true, trim: false });
  let stack = [];
  let root = null;
  parser.onopentag = (n) => {
    const node = { tag: n.name, attrs: n.attributes, children: [], text: '' };
    if (stack.length) stack[stack.length - 1].children.push(node);
    stack.push(node);
    if (stack.length === 2) root = node;           // depth 1 = <stream>, depth 2 = top element
  };
  parser.ontext = (t) => { if (stack.length) stack[stack.length - 1].text += t; };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => {
    const node = stack.pop();
    if (stack.length === 1 && node === root) { onElement(node); root = null; stack[0].children = []; }
  };
  parser.onerror = (e) => { log.warn('XML parse error from MI:', e.message); parser.error = null; };
  return parser;
}
const kids = (n, tag) => n.children.filter((c) => c.tag === tag);
const child = (n, tag) => n.children.find((c) => c.tag === tag);
const findAll = (n, path) => path.split('/').reduce((acc, t) => acc.flatMap((x) => kids(x, t)), [n]);

// ----------------------------------------------------------------- MI connection
class MIConnection {
  constructor(c, onElement) { this.c = c; this.onElement = onElement; this.conn = null; this.chan = null; this.alive = false; }

  connect() {
    if (DRY) { log.info(`[dry-run] would connect to ${this.c.host}:${this.c.port} subsystem=${this.c.subsystem}`); this.alive = true; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const conn = new Client();
      this.conn = conn;
      conn.on('ready', () => {
        conn.subsys(this.c.subsystem || 'linterface', (err, stream) => {
          if (err) return reject(err);
          this.chan = stream; this.alive = true;
          const parser = makeStreamParser((el) => { try { this.onElement(el); } catch (e) { log.error(`handler failed for <${el.tag}>:`, e); } });
          stream.on('data', (d) => { log.debug('<<', d.toString().slice(0, 500)); parser.write(d.toString('utf8')); });
          stream.on('close', () => { log.warn('MI channel closed'); this.alive = false; conn.end(); });
          stream.stderr.on('data', (d) => log.warn('MI stderr:', d.toString()));
          stream.write(STREAM_HEADER);
          log.info(`Connected to MI ${this.c.host}:${this.c.port} as ${this.c.login}, stream opened`);
          resolve();
        });
      });
      conn.on('error', (e) => { this.alive = false; reject(e); });
      conn.on('close', () => { this.alive = false; });
      conn.connect({
        host: this.c.host, port: Number(this.c.port || 722), username: this.c.login,
        privateKey: fs.readFileSync(this.c.private_key),
        keepaliveInterval: (this.c.keepalive_sec ?? 30) * 1000, keepaliveCountMax: 3,
        readyTimeout: 30000,
      });
    });
  }

  send(xml) {
    if (DRY) { log.info('[dry-run] >>', xml.length > 2000 ? xml.slice(0, 2000) + '...' : xml); return; }
    if (!this.chan || !this.alive) throw new Error('not connected');
    this.chan.write(xml + '\n');
    log.debug('>>', xml.slice(0, 500));
  }

  close() { this.alive = false; try { this.chan?.end(); this.conn?.end(); } catch { /* ignore */ } this.chan = this.conn = null; }
}

// ----------------------------------------------------------------- bridge
class Bridge {
  constructor(cfg) {
    this.cfg = cfg;
    this.traccar = new Traccar(cfg.traccar);
    this.mi = new MIConnection(cfg.mi, (el) => this.onMiElement(el));
    this.lcenters = [...cfg.lcenters];
    this.online = new Map();          // vid -> Set(lcenter)
    this.states = new Map();          // vid -> runtime state
    for (const vid of cfg.vehicles.keys()) this.states.set(vid, { lastGpsTime: null, lastStateTime: null, lastMoto: null, lastDoor: null, lastLock: null, lastPanic: null, lastStateSentAt: 0, pendingOffTime: null });
    this.catalogueSentAt = 0;
    this.catalogueNeeded = false;
    this.stopping = false;
  }

  isOnline(vid) { return (this.online.get(vid)?.size || 0) > 0; }

  // ---- incoming from MI
  onMiElement(el) {
    switch (el.tag) {
      case 'lcenterlist':
        this.lcenters = kids(el, 'lcenter').map((c) => c.text.trim()).filter(Boolean);
        log.info('lcenterList from MI:', this.lcenters);
        this.catalogueNeeded = true;
        break;
      case 'onlineregime':
        for (const v of kids(el, 'vehicle')) {
          const vid = v.attrs.vid, on = v.attrs.online === '1', lc = v.attrs.lcenter;
          if (!this.online.has(vid)) this.online.set(vid, new Set());
          const s = this.online.get(vid);
          if (on) {
            const wasOnline = s.size > 0;
            s.add(lc || '*');
            if (this.cfg.vehicles.has(vid) && !wasOnline) this.sendInitial(vid).catch((e) => log.warn('initial send failed:', e.message));
          } else if (lc) s.delete(lc); else s.clear();
          if (v.attrs.hasroute === '1') for (const r of findAll(v, 'routelist/route')) log.info(`route for vid=${vid} name=${r.attrs.name} polyline(len=${r.text.length}) – not forwarded to vehicle`);
        }
        log.info('onlineRegime: online vids=', [...this.online].filter(([, s]) => s.size).map(([k]) => k));
        break;
      case 'dispatchermessagedata':
        for (const m of kids(el, 'message')) {
          const names = findAll(m, 'attachments/attachment').map((x) => child(x, 'name')?.text);
          log.info(`Dispatcher message -> vid=${m.attrs.vid} time=${m.attrs.time} text=${JSON.stringify((child(m, 'text')?.text || '').trim())} attachments=${JSON.stringify(names)}`);
          // TODO: forward to vehicle communication console (Traccar command / SMS / app push)
        }
        break;
      case 'testecho': log.info('testEcho from MI:', JSON.stringify(el.text)); break;
      case 'catalogue': log.info(`catalogue echo from MI (getCatalogue): ${findAll(el, 'vehiclelist/vehicleinfo').length} vehicles`); break;
      default: log.info(`unhandled element from MI: <${el.tag}>`);
    }
  }

  // ---- outgoing
  sendProvider() { if (this.cfg.provider) this.mi.send(buildProvider(this.cfg.provider)); }

  sendCatalogue() {
    if (!this.lcenters.length) log.warn('no logistic centers known yet – catalogue relations will be empty');
    this.mi.send(buildCatalogue(this.cfg, this.lcenters));
    this.catalogueSentAt = Date.now(); this.catalogueNeeded = false;
    log.info(`catalogue sent (${this.cfg.vehicles.size} vehicles, lcenters=${JSON.stringify(this.lcenters)})`);
  }

  moto(v, p) {
    const at = p.attributes || {};
    let val = at[v.ignitionAttr];
    if (val === undefined) val = at.motion;
    if (val === undefined) val = (p.speed || 0) > 2;      // knots
    return isTrue(val) ? 1 : 0;
  }
  flag(at, name) { if (!name || at[name] === undefined) return null; return isTrue(at[name]) ? 1 : 0; }

  async sendInitial(vid) {
    const v = this.cfg.vehicles.get(vid);
    if (v.traccarDeviceId == null) return;
    const pos = (await this.traccar.latestPositions()).get(v.traccarDeviceId);
    if (pos) this.emit([{ vid, pts: [pos], force: true }]);
  }

  async pollOnce() {
    const batch = [];
    const now = Date.now();
    for (const [vid, v] of this.cfg.vehicles) {
      if (!this.isOnline(vid) || v.traccarDeviceId == null) continue;
      const st = this.states.get(vid);
      const from = (st.lastGpsTime ?? now - 15 * 60000) + 1000;
      let pts;
      try { pts = await this.traccar.positionsBetween(v.traccarDeviceId, from, now); }
      catch (e) { log.warn(`traccar history failed for vid=${vid}: ${e.message}`); continue; }
      const fresh = pts.filter((p) => p.valid !== false && (!st.lastGpsTime || new Date(p.fixTime).getTime() > st.lastGpsTime));
      batch.push({ vid, pts: fresh, force: false });
    }
    this.emit(batch);
  }

  emit(batch) {
    const nowTs = Date.now();
    const parts = [];
    for (let { vid, pts, force } of batch) {
      const v = this.cfg.vehicles.get(vid), st = this.states.get(vid);
      const gps = [], state = [], temp = [];
      for (const p of pts) {
        const t = new Date(p.fixTime).getTime();
        const at = p.attributes || {};
        const moto = this.moto(v, p);
        const door = this.flag(at, v.doorAttr), lock = this.flag(at, v.doorLockAttr), panic = this.flag(at, v.panicAttr);

        // GPS points: all while moving; while standing only the last one matters
        if (moto || st.lastMoto === null || st.lastMoto === 1) gps.push(`<gps${A({ time: utcIso(t), lat: +p.latitude.toFixed(6), lng: +p.longitude.toFixed(6) })}/>`);
        st.lastGpsTime = t;

        // moto change with short-stop filtering (spec: filter intersections / traffic jams)
        let motoChanged = false, tState = t;
        if (st.lastMoto === null) motoChanged = true;
        else if (moto !== st.lastMoto) {
          if (moto === 0) {
            if (st.pendingOffTime === null) st.pendingOffTime = t;
            if ((t - st.pendingOffTime) / 1000 >= this.cfg.stopFilterSec) { motoChanged = true; tState = st.pendingOffTime; }
          } else { motoChanged = true; st.pendingOffTime = null; }
        } else st.pendingOffTime = null;
        const effMoto = motoChanged ? moto : st.lastMoto;
        const otherChanged = door !== st.lastDoor || lock !== st.lastLock || panic !== st.lastPanic;

        if (motoChanged || otherChanged || force) {
          if (st.lastStateTime === null || tState > st.lastStateTime) {
            state.push(`<state${A({ time: utcIso(tState), moto: effMoto, doorSensor: door, doorLock: lock, panic })}/>`);
            st.lastStateTime = tState; st.lastStateSentAt = nowTs;
          }
          st.lastMoto = effMoto; st.lastDoor = door; st.lastLock = lock; st.lastPanic = panic;
          if (motoChanged && moto === 0) st.pendingOffTime = null;
          force = false;
        }
        for (const ts of v.temperatureSensors) {
          const val = at[ts.attr || `temp${ts.tsid}`];
          if (val !== undefined) temp.push(`<temperature${A({ time: utcIso(t), tsid: ts.tsid, value: val })}/>`);
        }
      }
      // heartbeat <state> for standing vehicle (spec: at least every 15 min)
      if (st.lastMoto !== null && !state.length && nowTs - st.lastStateSentAt >= this.cfg.standingStateInterval) {
        if (st.lastStateTime === null || nowTs > st.lastStateTime) {
          state.push(`<state${A({ time: utcIso(nowTs), moto: st.lastMoto, doorSensor: st.lastDoor, doorLock: st.lastLock, panic: st.lastPanic })}/>`);
          st.lastStateTime = nowTs; st.lastStateSentAt = nowTs;
        }
      }
      if (gps.length || state.length || temp.length) {
        parts.push(`<vehicle${A({ vid })}>`
          + (gps.length ? `<gpsData>${gps.join('')}</gpsData>` : '')
          + (state.length ? `<stateData>${state.join('')}</stateData>` : '')
          + (temp.length ? `<temperatureData>${temp.join('')}</temperatureData>` : '')
          + '</vehicle>');
      }
    }
    if (parts.length) { this.mi.send(`<data>${parts.join('')}</data>`); log.info(`data sent for ${parts.length} vehicle(s)`); }
  }

  /** Fill traccarDeviceId from imei (Traccar uniqueId) via /api/devices. */
  async resolveDevices() {
    const missing = [...this.cfg.vehicles.values()].filter((v) => v.traccarDeviceId == null);
    if (!missing.length) return;
    const devices = await this.traccar.devices();
    const byUnique = new Map(devices.map((d) => [String(d.uniqueId), d]));
    for (const v of missing) {
      const d = v.imei && byUnique.get(v.imei);
      if (d) { v.traccarDeviceId = d.id; log.info(`vehicle ${v.vrn}: imei ${v.imei} -> Traccar device id ${d.id} (${d.name})`); }
      else log.warn(`vehicle ${v.vrn}: imei ${v.imei} NOT found in Traccar – no data will be sent for it`);
    }
  }

  // ---- main loop
  async run() {
    const stop = () => { log.info('shutdown requested'); this.stopping = true; this.mi.close(); setTimeout(() => process.exit(0), 500); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    while (!this.stopping) {
      try {
        try { await this.resolveDevices(); }
        catch (e) { log.error('Traccar not reachable (check traccar.url / user / password):', e.message); }
        await this.mi.connect();
        this.sendProvider();
        if (ECHO) this.mi.send('<testEcho>echo</testEcho>');
        for (let i = 0; i < 20 && !this.lcenters.length && !DRY; i++) await sleep(500);   // wait for lcenterList
        this.sendCatalogue();
        if (ONCE) { await sleep(5000); this.mi.close(); return; }
        let lastPoll = 0;
        while (!this.stopping && this.mi.alive) {
          if (this.catalogueNeeded || Date.now() - this.catalogueSentAt >= this.cfg.catalogueInterval) this.sendCatalogue();
          if (Date.now() - lastPoll >= this.cfg.pollInterval) { await this.pollOnce(); lastPoll = Date.now(); }
          await sleep(1000);
        }
      } catch (e) {
        log.error('connection error:', e.message);
      } finally { this.mi.close(); }
      if (!this.stopping) { log.info('reconnecting in 60s (per spec)'); await sleep(60000); }
    }
  }
}

new Bridge(loadConfig(cfgPath)).run().catch((e) => { log.error(e); process.exit(1); });
