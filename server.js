const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const multer = require("multer");
const { WebSocketServer } = require("ws");

const { EGGS, getEgg } = require("./lib/eggs");
const { users, servers, sessions, settings, audit, ensureSeed } = require("./lib/seed");
const runtime = require("./lib/runtime");
const playit = require("./lib/playit");
const catalog = require("./lib/catalog");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const COOKIE = "hn_session";

const seedInfo = ensureSeed();
if (seedInfo.seeded) {
  console.log("HoptoNode ilk kurulum:");
  console.log(`  Kurucu  →  ${seedInfo.founder.username}  /  ${seedInfo.founder.password}`);
  console.log(`  Yönetici →  ${seedInfo.admin.username}  /  ${seedInfo.admin.password}`);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

function logAudit(actor, action, detail) {
  const list = audit.all();
  list.unshift({ id: nanoid(10), at: new Date().toISOString(), actor, action, detail });
  audit.save(list.slice(0, 400));
}

function readToken(req) {
  const hdr = String(req.headers.authorization || "");
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (req.query && req.query.token) return String(req.query.token);
  return req.cookies[COOKIE] || "";
}

function getSession(req) {
  const token = readToken(req);
  if (!token) return null;
  const list = sessions.all();
  const s = list.find((x) => x.token === token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    sessions.save(list.filter((x) => x.token !== token));
    return null;
  }
  const user = users.all().find((u) => u.id === s.userId);
  if (!user || user.banned) return null;
  return { session: s, user, token };
}

function requireAuth(req, res, next) {
  const ctx = getSession(req);
  if (!ctx) return res.status(401).json({ error: "Oturum gerekli" });
  req.user = ctx.user;
  req.session = ctx.session;
  req.token = ctx.token;
  next();
}

function requireStaff(req, res, next) {
  requireAuth(req, res, () => {
    if (!["founder", "admin"].includes(req.user.role)) {
      return res.status(403).json({ error: "Yetkin yok" });
    }
    next();
  });
}

function requireFounder(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "founder") return res.status(403).json({ error: "Sadece kurucu" });
    next();
  });
}

function canSeeServer(user, server) {
  if (!server) return false;
  if (["founder", "admin"].includes(user.role)) return true;
  if (server.ownerId === user.id) return true;
  const subs = server.subusers || [];
  return subs.some((s) => s.userId === user.id);
}

function hostStats() {
  const cpus = os.cpus() || [];
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cores: cpus.length,
    cpuModel: cpus[0] ? cpus[0].model : "bilinmiyor",
    ramTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    ramFreeMb: Math.round(os.freemem() / 1024 / 1024),
    load: os.loadavg(),
    uptimeSec: Math.round(os.uptime()),
  };
}

function nextPort(protocol) {
  const used = new Set(servers.all().map((s) => Number(s.port)));
  let p = protocol === "bedrock" ? 19132 : 25565;
  while (used.has(p)) p += 1;
  return p;
}

function issueSession(req, res, user) {
  const token = crypto.randomBytes(24).toString("hex");
  const list = sessions.all();
  list.push({
    token,
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
    ip: req.ip,
  });
  sessions.save(list);
  const https = !!(req.secure || req.headers["x-forwarded-proto"] === "https");
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: https ? "none" : "lax",
    secure: https,
    maxAge: 14 * 24 * 60 * 60 * 1000,
    path: "/",
  });
  return token;
}

function decorate(server) {
  const egg = getEgg(server.eggId);
  const owner = users.all().find((u) => u.id === server.ownerId);
  const stats = runtime.statsOf(server);
  const join = playit.addressFor(server, egg && egg.protocol);
  return {
    ...server,
    status: stats.status,
    egg: egg
      ? { id: egg.id, name: egg.name, category: egg.category, protocol: egg.protocol, icon: egg.icon, short: egg.short }
      : null,
    owner: owner ? { id: owner.id, username: owner.username, displayName: owner.displayName } : null,
    stats,
    address: join || "playit-bekleniyor",
    joinReady: !!join,
  };
}

function validUsername(name) {
  return /^[a-zA-Z0-9_]{3,24}$/.test(name);
}

app.get("/api/health", (_req, res) => {
  const p = playit.status();
  res.json({
    ok: true,
    brand: "HoptiNode",
    time: Date.now(),
    playit: {
      configured: p.configured,
      running: p.running,
      java: p.javaAddress,
      bedrock: p.bedrockAddress,
    },
  });
});

app.get("/api/playit", requireAuth, (_req, res) => {
  res.json(playit.status());
});

app.get("/api/tunnels", (_req, res) => {
  const file = "/tmp/hn-live.json";
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    res.json(data);
  } catch {
    res.json({ updated: 0, tunnels: [] });
  }
});

app.get("/api/meta", (req, res) => {
  const s = settings.all();
  const ctx = getSession(req);
  res.json({
    brand: s.brand || "HoptoNode",
    tagline: s.tagline,
    registrationOpen: s.registrationOpen !== false,
    motd: s.motd,
    me: publicUser(ctx && ctx.user),
    host: { cores: hostStats().cores, ramTotalMb: hostStats().ramTotalMb },
  });
});

app.post("/api/auth/login", (req, res) => {
  const login = String(req.body.username || req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!login || !password) return res.status(400).json({ error: "Kullanıcı adı ve parola gerekli" });
  const user = users.all().find(
    (u) => u.username.toLowerCase() === login || String(u.email || "").toLowerCase() === login
  );
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "Kullanıcı adı veya parola hatalı" });
  }
  if (user.banned) return res.status(403).json({ error: "Hesap askıda" });
  const token = issueSession(req, res, user);
  logAudit(user.username, "login", req.ip);
  res.json({ user: publicUser(user), token });
});

app.post("/api/auth/register", (req, res) => {
  const s = settings.all();
  if (s.registrationOpen === false) {
    return res.status(403).json({ error: "Kayıt kapalı. Kurucudan davet iste." });
  }
  const username = String(req.body.username || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const confirm = req.body.passwordConfirm != null ? String(req.body.passwordConfirm) : password;
  const displayName = String(req.body.displayName || username).trim().slice(0, 40);
  if (!validUsername(username)) {
    return res.status(400).json({ error: "Kullanıcı adı 3-24 karakter olmalı (harf, rakam, _)" });
  }
  if (password.length < 6) return res.status(400).json({ error: "Parola en az 6 karakter" });
  if (password !== confirm) return res.status(400).json({ error: "Parolalar eşleşmiyor" });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "E-posta geçersiz" });
  }
  const list = users.all();
  if (list.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "Bu kullanıcı adı alınmış" });
  }
  if (email && list.some((u) => String(u.email || "").toLowerCase() === email)) {
    return res.status(409).json({ error: "Bu e-posta kayıtlı" });
  }
  const user = {
    id: nanoid(12),
    username,
    email,
    displayName: displayName || username,
    role: "user",
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
    ramQuotaMb: Number(s.defaultRamMb || 2048),
    cpuQuota: Number(s.defaultCpuPercent || 100),
    diskQuotaMb: Number(s.defaultDiskMb || 10240),
    unlimited: false,
    banned: false,
  };
  list.push(user);
  users.save(list);
  const token = issueSession(req, res, user);
  logAudit(user.username, "register", "yeni üye");
  res.json({ user: publicUser(user), token });
});

app.post("/api/auth/logout", (req, res) => {
  const token = readToken(req);
  if (token) sessions.save(sessions.all().filter((s) => s.token !== token));
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const mine = servers.all().filter((s) => canSeeServer(req.user, s));
  res.json({
    user: publicUser(req.user),
    host: hostStats(),
    usage: {
      servers: mine.length,
      ramMb: mine.reduce((a, s) => a + (s.memoryMb || 0), 0),
    },
  });
});

app.patch("/api/me", requireAuth, (req, res) => {
  const list = users.all();
  const u = list.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: "Yok" });
  if (req.body.displayName) u.displayName = String(req.body.displayName).slice(0, 40);
  if (req.body.email != null) {
    const email = String(req.body.email).trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "E-posta geçersiz" });
    }
    u.email = email;
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ error: "Parola en az 6 karakter" });
    u.passwordHash = bcrypt.hashSync(String(req.body.password), 10);
  }
  users.save(list);
  res.json({ user: publicUser(u) });
});

app.get("/api/eggs", requireAuth, (_req, res) => res.json({ eggs: EGGS }));

app.get("/api/activity", requireAuth, (req, res) => {
  const rows = audit.all().filter((a) => {
    if (["founder", "admin"].includes(req.user.role)) return true;
    return a.actor === req.user.username;
  });
  res.json({ activity: rows.slice(0, 50) });
});

app.get("/api/servers", requireAuth, (req, res) => {
  const all = servers.all();
  const mine = all.filter((s) => canSeeServer(req.user, s));
  res.json({ servers: mine.map(decorate) });
});

app.post("/api/servers", requireAuth, (req, res) => {
  const egg = getEgg(req.body.eggId);
  if (!egg) return res.status(400).json({ error: "Geçersiz yumurta" });
  let name = String(req.body.name || "").trim();
  if (name.length < 2) name = "sunucu-" + Date.now().toString(36).slice(-6);
  if (name.length > 32) name = name.slice(0, 32);

  const cfg = settings.all();
  const staff = ["founder", "admin"].includes(req.user.role) && cfg.staffUnlimited;
  let memoryMb = Number(req.body.memoryMb ?? cfg.defaultRamMb ?? 1024);
  let cpuPercent = Number(req.body.cpuPercent ?? cfg.defaultCpuPercent ?? 100);
  let diskMb = Number(req.body.diskMb ?? cfg.defaultDiskMb ?? 10240);
  if (!Number.isFinite(memoryMb) || memoryMb < 256) memoryMb = 256;
  if (!Number.isFinite(cpuPercent) || cpuPercent < 25) cpuPercent = 25;
  if (!Number.isFinite(diskMb) || diskMb < 512) diskMb = 512;

  if (!staff && !req.user.unlimited) {
    const capRam = req.user.ramQuotaMb || cfg.maxRamMbUser || 8192;
    const capCpu = req.user.cpuQuota || cfg.maxCpuPercentUser || 200;
    const capDisk = req.user.diskQuotaMb || 10240;
    const owned = servers.all().filter((s) => s.ownerId === req.user.id);
    const usedRam = owned.reduce((a, s) => a + (s.memoryMb || 0), 0);
    if (owned.length >= 8) return res.status(400).json({ error: "En fazla 8 sunucu" });
    if (usedRam + memoryMb > capRam) {
      return res.status(400).json({ error: `RAM kotan yetersiz. Kalan ${Math.max(0, capRam - usedRam)} MB.` });
    }
    memoryMb = Math.min(memoryMb, capRam);
    cpuPercent = Math.min(cpuPercent, capCpu);
    diskMb = Math.min(diskMb, capDisk);
  }

  const env = {};
  for (const v of egg.variables || []) {
    env[v.key] = String((req.body.env && req.body.env[v.key]) || v.default || "");
  }
  if (req.body.motd) env.MOTD = String(req.body.motd).slice(0, 80);

  const server = {
    id: nanoid(10),
    name,
    eggId: egg.id,
    ownerId: req.user.id,
    memoryMb,
    cpuPercent,
    diskMb,
    port: egg.protocol === "bedrock" ? 19132 : 25565,
    env,
    description: String(req.body.description || "").slice(0, 200),
    createdAt: new Date().toISOString(),
    uuid: crypto.randomUUID(),
    subusers: [],
    allocations: [],
    autoStart: req.body.autoStart !== false,
  };
  const list = servers.all();
  list.push(server);
  servers.save(list);
  runtime.ensureServerFiles(server);
  logAudit(req.user.username, "server.create", `${name} (${egg.id})`);
  const decorated = decorate(server);
  if (server.autoStart) {
    try {
      runtime.stopOthersOfProtocol(egg.protocol, server.id, servers.all());
      runtime.startServer(server);
    } catch (err) {
      /* still return created */
    }
  }
  res.json({ server: decorate(servers.all().find((s) => s.id === server.id) || server) });
});

app.get("/api/servers/:id", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  const rt = runtime.getRuntime(server.id);
  res.json({
    server: decorate(server),
    egg: getEgg(server.eggId),
    logs: rt ? rt.logs : [],
    host: hostStats(),
    backups: runtime.listBackups(server),
  });
});

app.get("/api/servers/:id/stats", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  res.json({ stats: runtime.statsOf(server), status: runtime.statusOf(server.id) });
});

app.patch("/api/servers/:id", requireAuth, (req, res) => {
  const list = servers.all();
  const server = list.find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  const staff = ["founder", "admin"].includes(req.user.role);
  if (req.body.name) server.name = String(req.body.name).slice(0, 32);
  if (req.body.description != null) server.description = String(req.body.description).slice(0, 200);
  if (req.body.autoStart != null) server.autoStart = !!req.body.autoStart;
  if (staff || req.user.unlimited || server.ownerId === req.user.id) {
    if (req.body.memoryMb) server.memoryMb = Math.max(256, Number(req.body.memoryMb));
    if (req.body.cpuPercent) server.cpuPercent = Math.max(25, Number(req.body.cpuPercent));
    if (req.body.diskMb) server.diskMb = Math.max(512, Number(req.body.diskMb));
    if (req.body.port) server.port = Number(req.body.port);
  }
  if (req.body.env && typeof req.body.env === "object") server.env = { ...server.env, ...req.body.env };
  servers.save(list);
  res.json({ server: decorate(server) });
});

app.delete("/api/servers/:id", requireAuth, (req, res) => {
  const list = servers.all();
  const server = list.find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  if (server.ownerId !== req.user.id && !["founder", "admin"].includes(req.user.role)) {
    return res.status(403).json({ error: "Silemezsin" });
  }
  runtime.stopServer(server.id, "SIGKILL");
  servers.save(list.filter((s) => s.id !== server.id));
  logAudit(req.user.username, "server.delete", server.name);
  res.json({ ok: true });
});

app.post("/api/servers/:id/power", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  const action = req.body.action;
  try {
    if (action === "start") {
      const egg = getEgg(server.eggId);
      runtime.stopOthersOfProtocol(egg && egg.protocol, server.id, servers.all());
      runtime.startServer(server);
    }
    else if (action === "stop") runtime.stopServer(server.id);
    else if (action === "restart") {
      runtime.stopServer(server.id);
      setTimeout(() => {
        try {
          runtime.startServer(server);
        } catch {
          /* */
        }
      }, 1600);
    } else if (action === "kill") runtime.stopServer(server.id, "SIGKILL");
    else return res.status(400).json({ error: "Bilinmeyen eylem" });
    logAudit(req.user.username, "server." + action, server.name);
    res.json({ ok: true, status: runtime.statusOf(server.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/servers/:id/console", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    runtime.sendCommand(server.id, String(req.body.command || ""));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/servers/:id/files", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    const root = runtime.ensureServerFiles(server);
    const dir = runtime.safeJoin(root, req.query.path || ".");
    if (!fs.existsSync(dir)) return res.status(404).json({ error: "Klasör yok" });
    if (!fs.statSync(dir).isDirectory()) return res.status(400).json({ error: "Klasör değil" });
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((ent) => {
      const st = fs.statSync(path.join(dir, ent.name));
      return { name: ent.name, type: ent.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtime.toISOString() };
    });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    res.json({ path: req.query.path || ".", entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/servers/:id/files/content", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    const file = runtime.safeJoin(runtime.ensureServerFiles(server), req.query.path || "");
    const st = fs.statSync(file);
    if (st.isDirectory()) return res.status(400).json({ error: "Bu bir klasör" });
    if (st.size > 1_500_000) return res.status(400).json({ error: "Dosya çok büyük" });
    res.json({ path: req.query.path, content: fs.readFileSync(file, "utf8") });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/servers/:id/files/content", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    const file = runtime.safeJoin(runtime.ensureServerFiles(server), req.body.path || "");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(req.body.content ?? ""));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/servers/:id/files/mkdir", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    fs.mkdirSync(runtime.safeJoin(runtime.ensureServerFiles(server), req.body.path || ""), { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/servers/:id/files", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    const root = runtime.ensureServerFiles(server);
    const target = runtime.safeJoin(root, req.query.path || req.body.path || "");
    if (target === path.resolve(root)) return res.status(400).json({ error: "Kök silinemez" });
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/servers/:id/files/upload", requireAuth, upload.single("file"), (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  if (!req.file) return res.status(400).json({ error: "Dosya yok" });
  try {
    const destDir = runtime.safeJoin(runtime.ensureServerFiles(server), req.body.path || ".");
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(req.file.originalname));
    fs.writeFileSync(dest, req.file.buffer);
    res.json({ ok: true, name: path.basename(req.file.originalname) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/servers/:id/backups", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  res.json({ backups: runtime.listBackups(server) });
});

app.post("/api/servers/:id/backups", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    const backup = runtime.createBackup(server, req.body.name);
    logAudit(req.user.username, "backup.create", server.name);
    res.json({ backup });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/servers/:id/backups/:bid/restore", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  try {
    runtime.restoreBackup(server, req.params.bid);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/servers/:id/backups/:bid", requireAuth, (req, res) => {
  const server = servers.all().find((s) => s.id === req.params.id);
  if (!canSeeServer(req.user, server)) return res.status(404).json({ error: "Sunucu yok" });
  runtime.deleteBackup(server, req.params.bid);
  res.json({ ok: true });
});

app.get("/api/admin/overview", requireStaff, (_req, res) => {
  const allUsers = users.all();
  const allServers = servers.all();
  res.json({
    host: hostStats(),
    counts: {
      users: allUsers.length,
      servers: allServers.length,
      online: allServers.filter((s) => runtime.statusOf(s.id) === "running").length,
    },
    users: allUsers.map(publicUser),
    servers: allServers.map(decorate),
    audit: audit.all().slice(0, 40),
    settings: settings.all(),
    eggs: EGGS,
  });
});

app.post("/api/admin/users", requireStaff, (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const role = ["user", "admin"].includes(req.body.role) ? req.body.role : "user";
  if (role === "admin" && req.user.role !== "founder") {
    return res.status(403).json({ error: "Admin yalnızca kurucu atayabilir" });
  }
  if (!validUsername(username) || password.length < 6) {
    return res.status(400).json({ error: "Geçersiz kullanıcı / parola" });
  }
  const list = users.all();
  if (list.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "Alınmış" });
  }
  const user = {
    id: nanoid(12),
    username,
    email: String(req.body.email || ""),
    displayName: String(req.body.displayName || username),
    role,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
    ramQuotaMb: Number(req.body.ramQuotaMb || 4096),
    cpuQuota: Number(req.body.cpuQuota || 200),
    diskQuotaMb: Number(req.body.diskQuotaMb || 20480),
    unlimited: !!req.body.unlimited,
    banned: false,
  };
  list.push(user);
  users.save(list);
  logAudit(req.user.username, "user.create", username);
  res.json({ user: publicUser(user) });
});

app.patch("/api/admin/users/:id", requireStaff, (req, res) => {
  const list = users.all();
  const u = list.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "Yok" });
  if (u.role === "founder" && req.user.role !== "founder") {
    return res.status(403).json({ error: "Kurucu düzenlenemez" });
  }
  if (req.body.role) {
    if (req.body.role === "founder") return res.status(400).json({ error: "Kurucu rolü devredilemez" });
    if (req.body.role === "admin" && req.user.role !== "founder") {
      return res.status(403).json({ error: "Admin yalnızca kurucu atayabilir" });
    }
    if (u.role !== "founder") u.role = req.body.role;
  }
  if (req.body.displayName) u.displayName = String(req.body.displayName);
  if (req.body.ramQuotaMb != null) u.ramQuotaMb = Number(req.body.ramQuotaMb);
  if (req.body.cpuQuota != null) u.cpuQuota = Number(req.body.cpuQuota);
  if (req.body.diskQuotaMb != null) u.diskQuotaMb = Number(req.body.diskQuotaMb);
  if (req.body.unlimited != null) u.unlimited = !!req.body.unlimited;
  if (req.body.banned != null && u.role !== "founder") u.banned = !!req.body.banned;
  if (req.body.password) u.passwordHash = bcrypt.hashSync(String(req.body.password), 10);
  users.save(list);
  logAudit(req.user.username, "user.edit", u.username);
  res.json({ user: publicUser(u) });
});

app.delete("/api/admin/users/:id", requireStaff, (req, res) => {
  const list = users.all();
  const u = list.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: "Yok" });
  if (u.role === "founder") return res.status(403).json({ error: "Kurucu silinemez" });
  if (u.role === "admin" && req.user.role !== "founder") {
    return res.status(403).json({ error: "Admini yalnızca kurucu silebilir" });
  }
  users.save(list.filter((x) => x.id !== u.id));
  logAudit(req.user.username, "user.delete", u.username);
  res.json({ ok: true });
});

app.patch("/api/admin/settings", requireFounder, (req, res) => {
  const s = settings.all();
  const allowed = [
    "tagline",
    "registrationOpen",
    "defaultRamMb",
    "defaultCpuPercent",
    "defaultDiskMb",
    "maxRamMbUser",
    "maxCpuPercentUser",
    "staffUnlimited",
    "motd",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) s[key] = req.body[key];
  }
  settings.save(s);
  logAudit(req.user.username, "settings", "panel ayarları");
  res.json({ settings: s });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: 0 }));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Yok" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/console" });

function tokenFromReq(req) {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("token")) return url.searchParams.get("token");
  const cookies = Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((p) => p[0])
  );
  return cookies[COOKIE] || "";
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = tokenFromReq(req);
  const sess = sessions.all().find((s) => s.token === token);
  const user = sess && users.all().find((u) => u.id === sess.userId);
  const serverId = url.searchParams.get("server");
  const game = servers.all().find((s) => s.id === serverId);
  if (!user || user.banned || !canSeeServer(user, game)) {
    ws.close();
    return;
  }
  const unsub = runtime.subscribe(serverId, (entry) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(entry));
  });
  const rt = runtime.getRuntime(serverId);
  if (rt) {
    for (const entry of rt.logs) {
      if (ws.readyState === 1) ws.send(JSON.stringify(entry));
    }
  }
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg.type === "cmd") runtime.sendCommand(serverId, msg.command);
    } catch {
      /* ignore */
    }
  });
  ws.on("close", unsub);
});

server.listen(PORT, HOST, () => {
  console.log(`HoptiNode panel  http://${HOST}:${PORT}`);
  playit.start().catch((err) => console.error("playit:", err.message));
});
