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
  address: null,
  addresses: [],
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

  const hits = [];
  const re =
    /([a-z0-9-]+\.(?:gl\.joinmc\.link|craft\.playit\.gg|joinmc\.link|playit\.gg|ply\.gg|at\.ply\.gg))(?::(\d+))?/gi;
  let m;
  while ((m = re.exec(line))) {
    hits.push(m[2] ? `${m[1]}:${m[2]}` : m[1]);
  }
  const ipPort = line.match(/\b(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})\b/);
  if (ipPort && !/^127\.|^0\.|^10\.|^192\.168\./.test(ipPort[1])) {
    hits.push(`${ipPort[1]}:${ipPort[2]}`);
  }
  if (hits.length) {
    for (const h of hits) {
      if (!state.addresses.includes(h)) state.addresses.push(h);
    }
    if (!state.address) state.address = hits[0];
  }
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
  const attempts = [
    { Authorization: "Agent-Key " + secret },
    { Authorization: secret },
    { Authorization: "Bearer " + secret },
  ];
  let last = null;
  for (const headers of attempts) {
    last = await httpJson("POST", pathName, body || {}, headers);
    if (last.status !== 401 && last.status !== 403) return last;
  }
  return last;
}

function pickAddressFromTunnels(payload) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === "string") {
      if (/playit\.gg|joinmc\.link|ply\.gg/i.test(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;
    const host =
      node.assigned_domain ||
      node.assignedDomain ||
      node.domain ||
      node.hostname ||
      node.ip_hostname ||
      node.ipHostname ||
      node.display_address ||
      node.displayAddress ||
      node.address;
    const port =
      node.port ||
      (node.port_start != null ? node.port_start : null) ||
      (node.from_port != null ? node.from_port : null) ||
      (node.alloc && (node.alloc.port || node.alloc.port_start));
    if (host && typeof host === "string") {
      found.push(port ? `${host}:${port}` : host);
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(payload);
  return found.filter((x, i, a) => a.indexOf(x) === i);
}

async function refreshFromApi() {
  try {
    const rundata = await apiCall("/agents/rundata", {});
    if (rundata && rundata.status < 400) {
      const addrs = pickAddressFromTunnels(rundata.json);
      if (addrs.length) {
        state.addresses = [...new Set([...state.addresses, ...addrs])];
        state.address = state.address || addrs[0];
      }
    }
    const listed = await apiCall("/tunnels/list", {});
    if (listed && listed.status < 400) {
      const addrs = pickAddressFromTunnels(listed.json);
      if (addrs.length) {
        state.addresses = [...new Set([...state.addresses, ...addrs])];
        state.address = state.address || addrs[0];
      }
      return listed.json;
    }
  } catch (err) {
    state.lastError = err.message;
  }
  return null;
}

function tunnelList(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.tunnels)) return json.tunnels;
  if (json.data && Array.isArray(json.data.tunnels)) return json.data.tunnels;
  if (json.data && Array.isArray(json.data)) return json.data;
  return [];
}

async function ensureTunnel() {
  const listed = await refreshFromApi();
  const existing = tunnelList(listed);
  if (existing.length) return existing;
  const bodies = [
    {
      name: "hoptinode-java",
      tunnel_type: "minecraft-java",
      port_type: "tcp",
      port_count: 1,
      origin: { type: "default", data: { local_ip: "127.0.0.1", local_port: 25565 } },
      enabled: true,
    },
    {
      name: "hoptinode-java",
      tunnelType: "minecraft-java",
      portType: "tcp",
      portCount: 1,
      origin: { type: "default", data: { localIp: "127.0.0.1", localPort: 25565 } },
      enabled: true,
    },
  ];
  for (const body of bodies) {
    try {
      const created = await apiCall("/tunnels/create", body);
      if (created && created.status < 400) {
        await refreshFromApi();
        return created.json;
      }
      state.lastError = `tunnel create ${created && created.status}`;
    } catch (err) {
      state.lastError = err.message;
    }
  }
  return null;
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
  const args = ["--secret", secret, "--platform-docker", "-l", path.join(BIN_DIR, "playit.log")];
  const child = spawn(BIN_PATH, args, {
    cwd: BIN_DIR,
    env: { ...process.env, SECRET_KEY: secret },
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
  const secret = secretKey();
  if (!secret) {
    state.lastError = "PLAYIT_SECRET_KEY yok";
    return status();
  }
  state.secret = secret;
  try {
    await ensureBinary();
    startAgent(secret);
    setTimeout(() => {
      ensureTunnel().catch(() => {});
    }, 4000);
    setInterval(() => {
      refreshFromApi().catch(() => {});
    }, 20000).unref();
  } catch (err) {
    state.lastError = err.message;
  }
  return status();
}

function addressFor(server) {
  if (state.address) {
    if (server && Number(server.port) && !/:\d+$/.test(state.address) && Number(server.port) !== 25565) {
      return `${state.address}:${server.port}`;
    }
    return state.address;
  }
  if (process.env.PUBLIC_JOIN_HOST) {
    return `${process.env.PUBLIC_JOIN_HOST}${server && server.port ? ":" + server.port : ""}`;
  }
  return null;
}

function status() {
  return {
    configured: !!secretKey(),
    running: state.running,
    address: state.address,
    addresses: state.addresses.slice(),
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
