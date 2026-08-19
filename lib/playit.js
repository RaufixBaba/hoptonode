"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

const BIN_URL = process.env.PLAYIT_BIN_URL || "https://builds.playit.gg/1.0.10/playit-linux-amd64";
const BIN_DIR = process.env.PLAYIT_DIR || path.join(osTmp(), "hoptinode-playit");
const BIN_PATH = path.join(BIN_DIR, "playit");
const API = "https://api.playit.gg";

const state = {
  child: null,
  secret: null,
  running: false,
  javaAddress: process.env.PLAYIT_JAVA_ADDRESS || null,
  bedrockAddress: process.env.PLAYIT_BEDROCK_ADDRESS || null,
  addresses: [],
  tunnels: [],
  claimUrl: null,
  lastError: null,
  logTail: [],
};

function osTmp() {
  return process.env.TMPDIR || process.env.TEMP || "/tmp";
}

function secretKey() {
  return String(process.env.PLAYIT_SECRET_KEY || process.env.SECRET_KEY || "").trim();
}

function pushLog(line) {
  const text = String(line || "").replace(/\n$/, "");
  if (!text) return;
  state.logTail.push(text);
  if (state.logTail.length > 80) state.logTail.splice(0, state.logTail.length - 80);
  parseLine(text);
}

function parseLine(line) {
  const claim = line.match(/https?:\/\/playit\.gg\/claim\/[A-Za-z0-9_-]+/i);
  if (claim) state.claimUrl = claim[0];
}

function httpJson(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const u = new URL(API + urlPath);
    const headers = {
      Accept: "application/json",
      ...(extraHeaders || {}),
    };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          let json = null;
          try {
            json = d ? JSON.parse(d) : null;
          } catch {
            json = { raw: d };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error("playit api timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function apiCall(pathName, body) {
  const secret = state.secret || secretKey();
  if (!secret) throw new Error("PLAYIT_SECRET_KEY yok");
  return httpJson("POST", pathName, body || {}, { Authorization: "Agent-Key " + secret });
}

function asPort(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof value === "object") {
    if (value.from != null) return asPort(value.from);
    if (value.port_start != null) return asPort(value.port_start);
    if (value.portStart != null) return asPort(value.portStart);
  }
  return null;
}

function kindOfTunnel(t) {
  const type = String(t.tunnel_type || t.tunnelType || "").toLowerCase();
  const proto = String(t.proto || t.port_type || t.portType || "").toLowerCase();
  const local =
    asPort(t.local_port) ||
    asPort(t.localPort) ||
    asPort(t.origin && t.origin.data && t.origin.data.local_port);
  if (type.includes("bedrock") || proto === "udp" || local === 19132) return "bedrock";
  return "java";
}

function formatTunnel(t) {
  const alloc = t.alloc && t.alloc.data ? t.alloc.data : {};
  const host =
    alloc.assigned_domain ||
    t.assigned_domain ||
    alloc.assigned_srv ||
    t.assigned_srv ||
    alloc.ip_hostname ||
    null;
  const port =
    asPort(alloc.port_start) ||
    asPort(t.port) ||
    asPort(t.port_start) ||
    asPort(alloc.port);
  if (!host || typeof host !== "string") return null;
  return port ? `${host}:${port}` : host;
}

function applyTunnels(list) {
  state.tunnels = list.map((t) => {
    const kind = kindOfTunnel(t);
    const address = formatTunnel(t);
    return {
      id: t.id,
      name: t.name,
      kind,
      address,
      localPort:
        asPort(t.local_port) ||
        asPort(t.origin && t.origin.data && t.origin.data.local_port) ||
        (kind === "bedrock" ? 19132 : 25565),
      type: t.tunnel_type || t.tunnelType,
      proxy: t.proxy_protocol || t.proxyProtocol || null,
      active: t.active !== false && !t.disabled,
    };
  });
  for (const t of state.tunnels) {
    if (!t.address) continue;
    if (t.kind === "bedrock") state.bedrockAddress = t.address;
    else state.javaAddress = t.address;
    if (!state.addresses.includes(t.address)) state.addresses.push(t.address);
  }
}

function tunnelList(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.tunnels)) return json.tunnels;
  if (json.data && Array.isArray(json.data.tunnels)) return json.data.tunnels;
  if (json.data && Array.isArray(json.data)) return json.data;
  return [];
}

async function refreshFromApi() {
  try {
    const listed = await apiCall("/tunnels/list", {});
    if (listed && listed.status < 400) {
      applyTunnels(tunnelList(listed.json));
      return listed.json;
    }
    const rundata = await apiCall("/agents/rundata", {});
    if (rundata && rundata.status < 400) {
      applyTunnels(tunnelList(rundata.json));
      return rundata.json;
    }
  } catch (err) {
    state.lastError = err.message;
  }
  return null;
}

async function ensureTunnel() {
  const listed = await refreshFromApi();
  if (state.javaAddress || state.bedrockAddress) {
    state.lastError = null;
    return tunnelList(listed);
  }
  return [];
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 6) return reject(new Error("çok fazla yönlendirme"));
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(res.headers.location, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("playit indirme " + res.statusCode));
          }
          const tmp = dest + ".part";
          const out = fs.createWriteStream(tmp);
          res.pipe(out);
          out.on("finish", () => {
            out.close(() => {
              fs.renameSync(tmp, dest);
              fs.chmodSync(dest, 0o755);
              resolve(dest);
            });
          });
          out.on("error", reject);
        })
        .on("error", reject);
    };
    go(url, 0);
  });
}

async function ensureBinary() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (fs.existsSync(BIN_PATH) && fs.statSync(BIN_PATH).size > 100000) return BIN_PATH;
  await download(BIN_URL, BIN_PATH);
  return BIN_PATH;
}

function startAgent(secret) {
  if (state.child) return;
  state.secret = secret;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const sock = path.join(BIN_DIR, "playit.sock");
  try {
    if (fs.existsSync(sock)) fs.unlinkSync(sock);
  } catch {
    /* */
  }
  const args = [
    "--secret",
    secret,
    "--platform-docker",
    "--socket-path",
    sock,
    "-l",
    path.join(BIN_DIR, "playit.log"),
  ];
  const child = spawn(BIN_PATH, args, {
    cwd: BIN_DIR,
    env: { ...process.env, SECRET_KEY: secret, HOME: BIN_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  state.running = true;
  const onData = (buf) => {
    String(buf)
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach(pushLog);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    state.running = false;
    state.child = null;
    state.lastError = "playit çıktı kod " + (code ?? "?");
  });
  child.on("error", (err) => {
    state.running = false;
    state.child = null;
    state.lastError = err.message;
  });
}

async function start() {
  if (process.env.PLAYIT_JAVA_ADDRESS) state.javaAddress = process.env.PLAYIT_JAVA_ADDRESS;
  if (process.env.PLAYIT_BEDROCK_ADDRESS) state.bedrockAddress = process.env.PLAYIT_BEDROCK_ADDRESS;
  const secret = secretKey();
  if (!secret) {
    state.lastError = "PLAYIT_SECRET_KEY yok";
    return status();
  }
  state.secret = secret;
  try {
    await ensureBinary();
    startAgent(secret);
    console.log("playit agent started");
    setTimeout(() => {
      ensureTunnel().catch((err) => console.log("playit tunnel:", err.message));
    }, 2500);
    setInterval(() => {
      refreshFromApi().catch(() => {});
    }, 15000).unref();
  } catch (err) {
    state.lastError = err.message;
  }
  return status();
}

function protocolOf(server, protocol) {
  if (protocol) return protocol;
  if (server && server.protocol) return server.protocol;
  if (server && Number(server.port) === 19132) return "bedrock";
  return "java";
}

function addressFor(server, protocol) {
  const proto = protocolOf(server, protocol);
  if (proto === "bedrock") return state.bedrockAddress || process.env.PLAYIT_BEDROCK_ADDRESS || null;
  return state.javaAddress || process.env.PLAYIT_JAVA_ADDRESS || null;
}

function status() {
  return {
    configured: !!secretKey(),
    running: state.running,
    address: state.javaAddress,
    javaAddress: state.javaAddress,
    bedrockAddress: state.bedrockAddress,
    addresses: state.addresses.slice(),
    tunnels: state.tunnels,
    claimUrl: state.claimUrl,
    error: secretKey() ? state.lastError : "PLAYIT_SECRET_KEY yok",
    logs: state.logTail.slice(-20),
  };
}

module.exports = {
  start,
  status,
  addressFor,
  ensureTunnel,
  refreshFromApi,
};
