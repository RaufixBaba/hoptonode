/* HoptiNode statik motor */
(function () {
  const EGGS = [
    { id: "paper", name: "Paper", short: "Yüksek performanslı Java", category: "java", protocol: "java", startup: "java -jar server.jar", variables: [{ key: "MC_VERSION", name: "Sürüm", default: "1.21.4" }, { key: "MAX_PLAYERS", name: "Maks. oyuncu", default: "40" }] },
    { id: "vanilla-java", name: "Minecraft Java — Vanilla", short: "Resmi vanilla", category: "java", protocol: "java", startup: "java -jar server.jar", variables: [{ key: "MC_VERSION", name: "Sürüm", default: "1.21.4" }] },
    { id: "fabric", name: "Fabric", short: "Mod yükleyici", category: "modded", protocol: "java", startup: "java -jar fabric-server-launch.jar", variables: [{ key: "MC_VERSION", name: "Sürüm", default: "1.21.4" }] },
    { id: "forge", name: "Forge", short: "Klasik modlar", category: "modded", protocol: "java", startup: "java @unix_args.txt", variables: [{ key: "MC_VERSION", name: "Sürüm", default: "1.20.1" }] },
    { id: "bedrock", name: "Bedrock Dedicated", short: "Resmi Bedrock", category: "bedrock", protocol: "bedrock", startup: "./bedrock_server", variables: [{ key: "MAX_PLAYERS", name: "Maks. oyuncu", default: "20" }] },
    { id: "pocketmine", name: "PocketMine-MP", short: "PHP Bedrock", category: "bedrock", protocol: "bedrock", startup: "php PocketMine-MP.phar", variables: [{ key: "MAX_PLAYERS", name: "Maks. oyuncu", default: "30" }] },
  ];
  const KEY = "hn_db_v3";
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  }
  function save(db) { localStorage.setItem(KEY, JSON.stringify(db)); }
  function seed() {
    let db = load();
    if (db && db.users && db.users.length) return db;
    db = {
      users: [
        { id: "u1", username: "kurucu", email: "kurucu@hoptinode.local", displayName: "Kurucu", role: "founder", password: "Kurucu#2026", ramQuotaMb: 0, unlimited: true, banned: false },
        { id: "u2", username: "arkadas", email: "admin@hoptinode.local", displayName: "Yönetici", role: "admin", password: "Admin#2026", ramQuotaMb: 0, unlimited: true, banned: false },
      ],
      sessions: {}, servers: [], fs: {}, logs: {}, backups: {},
      audit: [{ id: "a1", at: new Date().toISOString(), actor: "system", action: "seed", detail: "HoptiNode" }],
      settings: { motd: "HoptiNode", registrationOpen: true },
    };
    save(db);
    return db;
  }
  function pub(u) { if (!u) return null; const { password, ...r } = u; return r; }
  function eggOf(id) { return EGGS.find((e) => e.id === id) || EGGS[0]; }
  function uid() { return Math.random().toString(36).slice(2, 12); }
  async function realIp() {
    try {
      const j = await fetch("https://api.ipify.org?format=json").then((r) => r.json());
      if (j && j.ip && j.ip !== "127.0.0.1") return j.ip;
    } catch (e) { /* */ }
    try {
      const t = (await fetch("https://icanhazip.com").then((r) => r.text())).trim();
      if (t && t !== "127.0.0.1") return t;
    } catch (e) { /* */ }
    return null;
  }
  function userFromAuth(db, headers) {
    const h = headers.Authorization || headers.authorization || "";
    const t = h.replace(/^Bearer\s+/i, "");
    return db.users.find((u) => u.id === db.sessions[t]) || null;
  }
  function pushLog(db, id, line, stream) {
    db.logs[id] = db.logs[id] || [];
    db.logs[id].push({ t: Date.now(), stream: stream || "stdout", line: String(line) });
    if (db.logs[id].length > 300) db.logs[id].splice(0, db.logs[id].length - 300);
  }
  function norm(p) { return String(p || ".").replace(/\\/g, "/").replace(/^\/+/, "") || "."; }
  function parentOf(p) { p = norm(p); if (p === ".") return "."; const i = p.lastIndexOf("/"); return i <= 0 ? "." : p.slice(0, i); }
  function baseOf(p) { p = norm(p); const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
  function ensureDir(db, sid, dir) {
    db.fs[sid] = db.fs[sid] || {};
    dir = norm(dir);
    const parts = dir === "." ? [] : dir.split("/");
    let cur = ".";
    db.fs[sid][cur] = db.fs[sid][cur] || { type: "dir", content: "", mtime: Date.now() };
    for (const part of parts) {
      cur = cur === "." ? part : cur + "/" + part;
      db.fs[sid][cur] = db.fs[sid][cur] || { type: "dir", content: "", mtime: Date.now() };
    }
  }
  function putFile(db, sid, path, content) {
    path = norm(path);
    ensureDir(db, sid, parentOf(path));
    db.fs[sid][path] = { type: "file", content: String(content ?? ""), mtime: Date.now() };
  }
  function listDir(db, sid, path) {
    path = norm(path);
    const fs = db.fs[sid] || {};
    const out = [];
    const seen = new Set();
    for (const key of Object.keys(fs)) {
      if (key === path) continue;
      let name;
      if (path === ".") name = key.includes("/") ? key.split("/")[0] : key;
      else if (key.startsWith(path + "/")) name = key.slice(path.length + 1).split("/")[0];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const full = path === "." ? name : path + "/" + name;
      const node = fs[full] || { type: "dir", content: "", mtime: Date.now() };
      const isDir = node.type !== "file" || Object.keys(fs).some((k) => k.startsWith(full + "/"));
      out.push({ name, type: node.type === "file" && !Object.keys(fs).some((k) => k.startsWith(full + "/")) ? "file" : (isDir && node.type !== "file" ? "dir" : node.type), size: (node.content || "").length, mtime: new Date(node.mtime || Date.now()).toISOString() });
    }
    out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return out;
  }
  function seedServerFiles(db, s, egg) {
    db.fs[s.id] = {};
    ensureDir(db, s.id, ".");
    ensureDir(db, s.id, "logs");
    ensureDir(db, s.id, "world");
    putFile(db, s.id, "eula.txt", "eula=true\n");
    putFile(db, s.id, "server.properties", "server-port=" + s.port + "\nmotd=" + (s.env.MOTD || s.name) + "\nmax-players=" + (s.env.MAX_PLAYERS || "20") + "\n");
    putFile(db, s.id, "ops.json", "[]\n");
    if (egg.category === "modded") { ensureDir(db, s.id, "mods"); putFile(db, s.id, "mods/README.txt", "Mod .jar buraya.\n"); }
    if (egg.id === "paper" || egg.id === "vanilla-java" || egg.id === "pocketmine") { ensureDir(db, s.id, "plugins"); putFile(db, s.id, "plugins/README.txt", "Eklenti buraya.\n"); }
  }
  function runCmd(db, s, raw) {
    const line = String(raw || "").trim();
    if (!line) return;
    pushLog(db, s.id, "> " + line, "stdin");
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ");
    const c = cmd.toLowerCase();
    const egg = eggOf(s.eggId);
    if (c === "help") pushLog(db, s.id, "Komutlar: help, say, list, stop, version, motd, op, deop, whitelist, difficulty, save-all, plugins, tps, memory, kick, ban, pardon, reload", "stdout");
    else if (c === "say") pushLog(db, s.id, "[Server] " + arg, "stdout");
    else if (c === "list") pushLog(db, s.id, "There are 0 of a max of " + (s.env.MAX_PLAYERS || 20) + " players online:", "stdout");
    else if (c === "stop" || c === "end") { s.status = "offline"; pushLog(db, s.id, "Stopping the server", "system"); }
    else if (c === "version") pushLog(db, s.id, "This server is running HoptiNode " + egg.id + " " + (s.env.MC_VERSION || "1.21.4"), "stdout");
    else if (c === "motd") { if (arg) { s.env.MOTD = arg; pushLog(db, s.id, "MOTD set to '" + arg + "'", "stdout"); } else pushLog(db, s.id, s.env.MOTD || s.name, "stdout"); }
    else if (c === "op") pushLog(db, s.id, arg ? "Made " + arg + " a server operator" : "Usage: op <player>", "stdout");
    else if (c === "deop") pushLog(db, s.id, "Made " + arg + " no longer a server operator", "stdout");
    else if (c === "whitelist") pushLog(db, s.id, "Whitelist: empty", "stdout");
    else if (c === "difficulty") pushLog(db, s.id, "Difficulty: " + (arg || "normal"), "stdout");
    else if (c === "save-all" || c === "save") pushLog(db, s.id, "Saved the game", "stdout");
    else if (c === "plugins") {
      const plugs = listDir(db, s.id, "plugins").filter((x) => x.type === "file").map((x) => x.name);
      pushLog(db, s.id, "Plugins (" + plugs.length + "): " + (plugs.join(", ") || "none"), "stdout");
    } else if (c === "tps") pushLog(db, s.id, "TPS from last 1m, 5m, 15m: 20.00, 20.00, 20.00", "stdout");
    else if (c === "memory") pushLog(db, s.id, "Heap " + Math.round((s.memoryMb || 1024) * 0.3) + " MB / " + s.memoryMb + " MB", "stdout");
    else if (c === "kick") pushLog(db, s.id, arg ? "Kicked " + arg : "Usage: kick <player>", "stdout");
    else if (c === "ban") pushLog(db, s.id, arg ? "Banned " + arg : "Usage: ban <player>", "stdout");
    else if (c === "pardon") pushLog(db, s.id, "Unbanned " + arg, "stdout");
    else if (c === "reload") { pushLog(db, s.id, "Reloading!", "stdout"); pushLog(db, s.id, "Reload complete.", "stdout"); }
    else pushLog(db, s.id, 'Unknown command. Type "help" for help.', "stderr");
  }
  function decorate(db, s) {
    const egg = eggOf(s.eggId);
    const owner = db.users.find((u) => u.id === s.ownerId);
    return {
      ...s,
      address: s.address,
      egg: { id: egg.id, name: egg.name, category: egg.category, protocol: egg.protocol, short: egg.short },
      owner: owner ? { id: owner.id, username: owner.username, displayName: owner.displayName } : null,
      stats: {
        status: s.status, engine: s.status === "running" ? "hoptinode" : null,
        cpu: s.status === "running" ? 8 : 0,
        memoryMb: s.status === "running" ? Math.round((s.memoryMb || 1024) * 0.28) : 0,
        diskBytes: Object.values(db.fs[s.id] || {}).reduce((a, n) => a + ((n.content || "").length || 0), 0),
        uptime: s.startedAt && s.status === "running" ? Date.now() - s.startedAt : 0, samples: [],
      },
    };
  }

  window.hnMock = async function (path, opts) {
    const db = seed();
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body && typeof opts.body === "object" ? opts.body : {};
    const headers = opts.headers || {};
    const me = userFromAuth(db, headers);
    const qs = Object.fromEntries(new URLSearchParams(path.split("?")[1] || ""));
    path = path.split("?")[0];

    if (path === "/api/health") return { ok: true, brand: "HoptiNode", time: Date.now() };
    if (path === "/api/tunnels") return { updated: Date.now(), tunnels: [] };
    if (path === "/api/meta") return { brand: "HoptiNode", registrationOpen: true, motd: db.settings.motd, me: pub(me), host: { cores: 4, ramTotalMb: 8192 } };
    if (path === "/api/auth/login" && method === "POST") {
      const login = String(body.username || "").toLowerCase();
      const u = db.users.find((x) => x.username.toLowerCase() === login || (x.email || "").toLowerCase() === login);
      if (!u || u.password !== body.password) throw new Error("Kullanıcı adı veya parola hatalı");
      const tok = uid() + uid();
      db.sessions[tok] = u.id;
      save(db);
      return { user: pub(u), token: tok };
    }
    if (path === "/api/auth/register" && method === "POST") {
      const username = String(body.username || "").trim();
      if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error("Kullanıcı adı 3-24 karakter");
      if (String(body.password || "").length < 6) throw new Error("Parola en az 6 karakter");
      if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) throw new Error("Bu kullanıcı adı alınmış");
      const u = { id: uid(), username, email: body.email || "", displayName: body.displayName || username, role: "user", password: body.password, ramQuotaMb: 2048, unlimited: false, banned: false };
      db.users.push(u);
      const tok = uid() + uid();
      db.sessions[tok] = u.id;
      save(db);
      return { user: pub(u), token: tok };
    }
    if (path === "/api/auth/logout" && method === "POST") {
      delete db.sessions[(headers.Authorization || "").replace(/^Bearer\s+/i, "")];
      save(db);
      return { ok: true };
    }
    if (!me && path !== "/api/meta") throw new Error("Oturum gerekli");
    if (path === "/api/me" && method === "GET") return { user: pub(me), host: { ramTotalMb: 8192, cores: 4, hostname: "hoptinode" } };
    if (path === "/api/me" && method === "PATCH") {
      if (body.displayName) me.displayName = body.displayName;
      if (body.email != null) me.email = body.email;
      if (body.password) me.password = body.password;
      save(db);
      return { user: pub(me) };
    }
    if (path === "/api/eggs") return { eggs: EGGS };
    if (path === "/api/activity") return { activity: db.audit.slice().reverse() };
    if (path === "/api/servers" && method === "GET") {
      const ip = await realIp();
      if (ip) {
        db.servers.forEach((s) => {
          if (!s.address || /^127\.|^0\.0\.0\.0/.test(s.address) || s.address.indexOf("play.hoptinode") !== -1) s.address = ip + ":" + s.port;
        });
        save(db);
      }
      return { servers: db.servers.map((s) => decorate(db, s)) };
    }
    if (path === "/api/servers" && method === "POST") {
      const egg = eggOf(body.eggId);
      const name = String(body.name || "").trim() || "sunucu";
      const port = Number(body.port) || (egg.protocol === "bedrock" ? 19132 : 25565 + db.servers.length);
      const ip = await realIp();
      if (!ip) throw new Error("Genel IP alınamadı, tekrar dene");
      const s = {
        id: uid(), name, eggId: egg.id, ownerId: me.id,
        memoryMb: Number(body.memoryMb || 1024), cpuPercent: Number(body.cpuPercent || 100), diskMb: Number(body.diskMb || 8192),
        port, address: ip + ":" + port,
        env: Object.assign({ MAX_PLAYERS: "20", MC_VERSION: "1.21.4", MOTD: body.motd || name }, body.env || {}),
        description: body.description || "", createdAt: new Date().toISOString(),
        uuid: (crypto.randomUUID && crypto.randomUUID()) || uid() + uid(),
        status: "running", startedAt: Date.now(),
      };
      db.servers.push(s);
      seedServerFiles(db, s, egg);
      pushLog(db, s.id, "Starting minecraft server version " + s.env.MC_VERSION, "stdout");
      pushLog(db, s.id, "Listening on " + s.address, "stdout");
      pushLog(db, s.id, "Done! For help, type \"help\"", "stdout");
      db.audit.push({ id: uid(), at: new Date().toISOString(), actor: me.username, action: "server.create", detail: name + " " + s.address });
      save(db);
      return { server: decorate(db, s) };
    }
    const m1 = path.match(/^\/api\/servers\/([^/]+)$/);
    const m2 = path.match(/^\/api\/servers\/([^/]+)\/(.+)$/);
    if (m1 || m2) {
      const id = (m1 || m2)[1];
      const rest = m1 ? "" : m2[2];
      const s = db.servers.find((x) => x.id === id);
      if (!s) throw new Error("Sunucu yok");
      if (rest === "" && method === "GET") {
        if (!s.address || /^127\.|^0\.0\.0\.0/.test(s.address)) {
          const ip = await realIp();
          if (ip) { s.address = ip + ":" + s.port; save(db); }
        }
        return { server: decorate(db, s), egg: eggOf(s.eggId), logs: db.logs[s.id] || [], backups: db.backups[s.id] || [], host: { ramTotalMb: 8192 } };
      }
      if (rest === "stats") return { stats: decorate(db, s).stats, status: s.status };
      if (rest === "power" && method === "POST") {
        if (body.action === "start" || body.action === "restart") {
          s.status = "running"; s.startedAt = Date.now();
          pushLog(db, s.id, "Listening on " + s.address, "stdout");
          pushLog(db, s.id, "Done! For help, type \"help\"", "stdout");
        }
        if (body.action === "stop" || body.action === "kill") {
          s.status = "offline";
          pushLog(db, s.id, "Stopping the server", "system");
        }
        save(db);
        return { ok: true, status: s.status };
      }
      if (rest === "console" && method === "POST") { runCmd(db, s, body.command); save(db); return { ok: true }; }
      if (rest === "files" && method === "GET") return { path: qs.path || ".", entries: listDir(db, s.id, qs.path || ".") };
      if (rest === "files/content" && method === "GET") {
        const node = (db.fs[s.id] || {})[norm(qs.path)];
        if (!node || node.type === "dir") throw new Error("Dosya yok");
        return { path: qs.path, content: node.content || "" };
      }
      if (rest === "files/content" && method === "PUT") { putFile(db, s.id, body.path, body.content); save(db); return { ok: true }; }
      if (rest === "files/mkdir" && method === "POST") { ensureDir(db, s.id, body.path); save(db); return { ok: true }; }
      if (rest === "files/upload" && method === "POST") { putFile(db, s.id, body.path, body.content || ""); save(db); return { ok: true, name: baseOf(body.path) }; }
      if (rest === "files/extract" && method === "POST") {
        for (const f of body.files || []) putFile(db, s.id, f.path, f.content);
        save(db);
        return { ok: true, count: (body.files || []).length };
      }
      if (rest === "files" && method === "DELETE") {
        const target = norm(qs.path || body.path);
        if (target === ".") throw new Error("Kök silinemez");
        const fs = db.fs[s.id] || {};
        Object.keys(fs).forEach((k) => { if (k === target || k.startsWith(target + "/")) delete fs[k]; });
        save(db);
        return { ok: true };
      }
      if (rest === "backups" && method === "GET") return { backups: db.backups[s.id] || [] };
      if (rest === "backups" && method === "POST") {
        const b = { id: uid(), name: "yedek-" + Date.now(), file: "backup.json", size: 1024, createdAt: new Date().toISOString() };
        db.backups[s.id] = db.backups[s.id] || [];
        db.backups[s.id].unshift(b);
        save(db);
        return { backup: b };
      }
      if (method === "PATCH") { Object.assign(s, body); save(db); return { server: decorate(db, s) }; }
      if (method === "DELETE" && rest === "") { db.servers = db.servers.filter((x) => x.id !== id); save(db); return { ok: true }; }
    }
    if (path === "/api/admin/overview") {
      return {
        host: { hostname: "hoptinode", cores: 4, ramTotalMb: 8192, ramFreeMb: 4096, cpuModel: "panel" },
        counts: { users: db.users.length, servers: db.servers.length, online: db.servers.filter((x) => x.status === "running").length },
        users: db.users.map(pub), servers: db.servers.map((x) => decorate(db, x)),
        audit: db.audit.slice(-40).reverse(), settings: db.settings, eggs: EGGS,
      };
    }
    if (path === "/api/admin/users" && method === "POST") {
      const u = { id: uid(), username: body.username, password: body.password, role: body.role || "user", displayName: body.username, unlimited: !!body.unlimited, ramQuotaMb: 4096, banned: false };
      db.users.push(u); save(db); return { user: pub(u) };
    }
    const um = path.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (um && method === "PATCH") {
      const u = db.users.find((x) => x.id === um[1]);
      if (u) Object.assign(u, body);
      save(db);
      return { user: pub(u) };
    }
    if (path === "/api/admin/settings" && method === "PATCH") {
      Object.assign(db.settings, body); save(db); return { settings: db.settings };
    }
    throw new Error("Yok");
  };
})();
