const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getEgg } = require("./eggs");
const unzip = require("./unzip");

const SERVERS_ROOT = path.join(__dirname, "..", "servers");
const WORKER = path.join(__dirname, "worker.js");
const MAX_LOG = 500;

const runtimes = new Map();

function serverDir(id) {
  return path.join(SERVERS_ROOT, id);
}

function safeJoin(root, rel = "") {
  const clean = String(rel || ".").replace(/\\/g, "/");
  if (clean.split("/").some((p) => p === "..")) throw new Error("Geçersiz yol");
  const resolved = path.resolve(root, clean);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("Geçersiz yol");
  return resolved;
}

function applyVars(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : `{{${key}}}`
  );
}

function buildVars(server, egg) {
  const env = { ...(server.env || {}) };
  return {
    MEMORY: String(server.memoryMb || 2048),
    MIN_MEMORY: String(Math.max(256, Math.floor((server.memoryMb || 2048) * 0.25))),
    SERVER_PORT: String(server.port || (egg && egg.defaultPort) || 25565),
    MAX_PLAYERS: env.MAX_PLAYERS || "20",
    MC_VERSION: env.MC_VERSION || "1.21.4",
    FORGE_VERSION: env.FORGE_VERSION || "47.3.0",
    NEOFORGE_VERSION: env.NEOFORGE_VERSION || "21.1.93",
    LOADER_VERSION: env.LOADER_VERSION || "0.16.10",
    ...env,
  };
}

function ensureServerFiles(server) {
  const egg = getEgg(server.eggId);
  const dir = serverDir(server.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
  fs.mkdirSync(path.join(dir, "world"), { recursive: true });
  if (egg) {
    for (const [name, content] of Object.entries(egg.files || {})) {
      const dest = path.join(dir, name);
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, applyVars(content, buildVars(server, egg)));
    }
    if (["fabric", "forge", "neoforge", "quilt"].includes(egg.id)) {
      fs.mkdirSync(path.join(dir, "mods"), { recursive: true });
    }
    if (["pocketmine", "paper", "vanilla-java", "nukkit"].includes(egg.id)) {
      fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
    }
  }
  const ident = path.join(dir, "server.properties");
  if (egg && !fs.existsSync(ident) && egg.files && egg.files["server.properties"]) {
    fs.writeFileSync(ident, applyVars(egg.files["server.properties"], buildVars(server, egg)));
  }
  return dir;
}

function diskUsage(dir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let ents = [];
      try {
        ents = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const e of ents) walk(path.join(p, e));
    } else total += st.size;
  };
  walk(dir);
  return total;
}

function emptyRuntime(id) {
  return {
    id,
    logs: [],
    listeners: new Set(),
    child: null,
    startedAt: null,
    status: "offline",
    samples: [],
    players: 0,
    engine: null,
  };
}

function getRuntime(id) {
  return runtimes.get(id) || null;
}

function ensureRt(id) {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = emptyRuntime(id);
    runtimes.set(id, rt);
  }
  return rt;
}

function pushLog(rt, line, stream = "stdout") {
  const entry = { t: Date.now(), stream, line: String(line).replace(/\n$/, "") };
  rt.logs.push(entry);
  if (rt.logs.length > MAX_LOG) rt.logs.splice(0, rt.logs.length - MAX_LOG);
  for (const fn of rt.listeners) {
    try {
      fn(entry);
    } catch {
      /* ignore */
    }
  }
}

function findBundledPhp(dir) {
  const candidates = [
    path.join(dir, "bin", "php7", "bin", "php"),
    path.join(dir, "bin", "php8", "bin", "php"),
    path.join(dir, "bin", "php5", "bin", "php"),
    path.join(dir, "bin", "php", "bin", "php"),
    path.join(dir, "bin", "php"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  const walk = (d, depth) => {
    if (depth > 4) return null;
    let ents = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name === "php") return full;
      if (e.isDirectory() && e.name !== "plugins" && e.name !== "worlds" && e.name !== "backups") {
        const hit = walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const binDir = path.join(dir, "bin");
  if (fs.existsSync(binDir)) return walk(binDir, 0);
  return null;
}

function javaHeapMb(wanted) {
  const total = Math.round(os.totalmem() / 1024 / 1024);
  const w = Number(wanted) || 512;
  return Math.max(256, Math.min(w, Math.max(256, total - 280), 768));
}

function curlText(url) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("curl", ["-fsSL", "--max-time", "40", url], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || "indirme hatası");
  return r.stdout;
}

function curlFile(url, dest) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("curl", ["-fsSL", "--max-time", "180", "-o", dest, url], { encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(dest) || fs.statSync(dest).size < 20000) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* */
    }
    throw new Error(r.stderr || "JAR inemedi");
  }
}

const PAPER_ALIAS = { "1.8.9": "1.8.8", "1.8": "1.8.8", "1.21.11": "1.21.10" };
const JAVA_PROTO = {
  "1.8.8": 47,
  "1.8.9": 47,
  "1.12.2": 340,
  "1.16.5": 754,
  "1.18.2": 758,
  "1.19.2": 760,
  "1.19.4": 762,
  "1.20.1": 763,
  "1.20.4": 765,
  "1.21.1": 767,
  "1.21.4": 769,
  "1.21.8": 772,
  "1.21.10": 773,
  "1.21.11": 773,
};

function javaProtocol(ver) {
  if (JAVA_PROTO[ver]) return JAVA_PROTO[ver];
  const m = String(ver || "").match(/^1\.(\d+)/);
  if (!m) return 769;
  const n = Number(m[1]);
  if (n <= 8) return 47;
  if (n <= 12) return 340;
  if (n <= 16) return 754;
  if (n <= 18) return 758;
  if (n <= 19) return 762;
  if (n <= 20) return 765;
  return 769;
}

function readJarMarker(dir) {
  try {
    return fs.readFileSync(path.join(dir, ".hn-mc-version"), "utf8").trim();
  } catch {
    return "";
  }
}
function writeJarMarker(dir, eggId, ver, jar) {
  fs.writeFileSync(path.join(dir, ".hn-mc-version"), `${eggId}\t${ver}\t${jar}\n`);
}

function downloadVanillaJar(ver, dest) {
  const man = JSON.parse(curlText("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"));
  const hit = (man.versions || []).find((v) => v.id === ver);
  if (!hit) throw new Error("vanilla " + ver + " yok");
  const det = JSON.parse(curlText(hit.url));
  const jarUrl = det.downloads && det.downloads.server && det.downloads.server.url;
  if (!jarUrl) throw new Error("vanilla jar yok: " + ver);
  curlFile(jarUrl, dest);
}

function downloadPaperJar(ver, dest) {
  const paperVer = PAPER_ALIAS[ver] || ver;
  const meta = JSON.parse(curlText(`https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(paperVer)}`));
  const build = (meta.builds || []).slice(-1)[0];
  if (!build) throw new Error("paper build yok");
  const name = `paper-${paperVer}-${build}.jar`;
  const url = `https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(paperVer)}/builds/${build}/downloads/${name}`;
  curlFile(url, dest);
}

function downloadFabricJar(ver, dest) {
  let loader = "0.16.10";
  let installer = "1.0.1";
  try {
    const loaders = JSON.parse(curlText(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(ver)}`));
    if (loaders[0] && loaders[0].loader) loader = loaders[0].loader.version;
  } catch {
    /* keep */
  }
  try {
    const inst = JSON.parse(curlText("https://meta.fabricmc.net/v2/versions/installer"));
    if (inst[0] && inst[0].version) installer = inst[0].version;
  } catch {
    /* keep */
  }
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(ver)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
  curlFile(url, dest);
}

function ensureJavaJar(egg, dir, version, rt) {
  const ver = String(version || "1.21.4").trim() || "1.21.4";
  const existing = detectJar(dir);
  const want = `${egg.id}\t${ver}\t`;
  const mark = readJarMarker(dir);
  if (existing && mark.startsWith(want) && mark.endsWith(existing)) return existing;
  if (existing && /\tyuklenen\t/.test(mark)) return existing;

  const destName = egg.id === "fabric" ? "fabric-server-launch.jar" : "server.jar";
  const dest = path.join(dir, destName);
  if (existing && mark && !mark.startsWith(want)) {
    try {
      fs.unlinkSync(path.join(dir, existing));
    } catch {
      /* */
    }
  }

  pushLog(rt, `[HoptoNode] ${egg.id} ${ver} JAR indiriliyor…`, "system");
  fs.writeFileSync(path.join(dir, "eula.txt"), "eula=true\n");
  if (egg.id === "fabric") {
    downloadFabricJar(ver, dest);
    writeJarMarker(dir, egg.id, ver, destName);
    return destName;
  }
  if (egg.id === "paper") {
    try {
      downloadPaperJar(ver, dest);
    } catch (err) {
      pushLog(rt, `[HoptoNode] Paper ${ver} yok (${err.message}), vanilla ${ver}`, "system");
      downloadVanillaJar(ver, dest);
    }
    writeJarMarker(dir, egg.id, ver, destName);
    return destName;
  }
  if (egg.id === "vanilla-java") {
    downloadVanillaJar(ver, dest);
    writeJarMarker(dir, egg.id, ver, destName);
    return destName;
  }
  return detectJar(dir);
}

function detectJar(dir) {
  const jars = [
    "server.jar",
    "paper.jar",
    "fabric-server-launch.jar",
    "quilt-server-launch.jar",
    "nukkit.jar",
    "forge.jar",
  ];
  return jars.find((j) => fs.existsSync(path.join(dir, j))) || null;
}

function sampleLoop(rt) {
  if (rt._sampler) return;
  rt._sampler = setInterval(() => {
    if (!rt.child || rt.status === "offline") return;
    let cpu = 0;
    let mem = 0;
    try {
      const usage = process.cpuUsage();
      mem = Math.round((process.memoryUsage().rss + (rt.child ? 40 * 1024 * 1024 : 0)) / 1024 / 1024);
      cpu = Math.min(100, Math.round((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100));
      if (rt.child.pid) {
        const status = fs.readFileSync(`/proc/${rt.child.pid}/status`, "utf8");
        const rss = /VmRSS:\s+(\d+)/.exec(status);
        if (rss) mem = Math.round(Number(rss[1]) / 1024);
      }
    } catch {
      mem = 48;
      cpu = 4;
    }
    rt.samples.push({ t: Date.now(), cpu, mem });
    if (rt.samples.length > 40) rt.samples.shift();
  }, 3000);
}

function startServer(server) {
  const egg = getEgg(server.eggId);
  if (!egg) throw new Error("Yumurta bulunamadı");
  const rt = ensureRt(server.id);
  if (rt.child && rt.status !== "offline") throw new Error("Sunucu zaten çalışıyor");

  let listenPort = Number(server.port) || (egg.protocol === "bedrock" ? 19132 : 25565);
  if (egg.protocol === "bedrock" && listenPort === 25565) listenPort = 19132;
  if (egg.protocol !== "bedrock" && listenPort === 19132) listenPort = 25565;
  server.port = listenPort;

  const dir = ensureServerFiles(server);
  writeListenPort(dir, listenPort);
  rt.status = "starting";
  rt.startedAt = Date.now();
  rt.players = 0;

  pushLog(rt, `[HoptoNode] ${server.name} kuruluyor…`, "system");
  pushLog(rt, `[HoptoNode] ${egg.name} · ${server.memoryMb} MB · ${server.cpuPercent}% · :${server.port}`, "system");

  const vars = buildVars(server, egg);
  if (["paper", "vanilla-java", "fabric"].includes(egg.id)) {
    try {
      ensureJavaJar(egg, dir, vars.MC_VERSION, rt);
    } catch (err) {
      pushLog(rt, `[HoptoNode] ${vars.MC_VERSION} JAR inemedi: ${err.message}`, "stderr");
    }
  }
  const jar = detectJar(dir);
  const phpPhar =
    (fs.existsSync(path.join(dir, "PocketMine-MP.phar")) && "PocketMine-MP.phar") ||
    (fs.readdirSync(dir).find((f) => /\.phar$/i.test(f)) || null);
  const bedrockBin = fs.existsSync(path.join(dir, "bedrock_server"));

  let cmd = process.execPath;
  let args = [WORKER];
  let extraEnv = {
    HN_NAME: server.name,
    HN_PORT: String(listenPort),
    HN_PROTOCOL: egg.protocol || "java",
    HN_MOTD: (server.env && server.env.MOTD) || `HoptoNode ${server.name}`,
    HN_MAX_PLAYERS: String(vars.MAX_PLAYERS || 20),
    HN_VERSION: String(
      egg.id === "pocketmine"
        ? vars.BDX_VERSION || "0.14.3"
        : egg.protocol === "bedrock"
          ? vars.BDX_VERSION || vars.GAME_VERSION || "1.26.44"
          : vars.MC_VERSION || "1.21.4"
    ),
    HN_GAME_PROTOCOL:
      egg.protocol === "bedrock" ? "2168" : String(javaProtocol(vars.MC_VERSION || "1.21.4")),
    HN_EGG: egg.id,
    HN_DIR: dir,
  };
  let engine = "hoptonode";

  if (jar) {
    extraEnv.HN_JAR = jar;
    pushLog(rt, `[HoptoNode] JAR bulundu (${jar}). Java varsa onunla açılacak, yoksa dahili motor kullanılacak.`, "system");
    const javaTry = spawn("java", ["-version"], { stdio: "ignore" });
    javaTry.on("error", () => {});
  }

  if (jar && commandExists("java")) {
    const heap = javaHeapMb(server.memoryMb);
    const xmin = Math.min(256, heap);
    cmd = "java";
    args = [`-Xms${xmin}M`, `-Xmx${heap}M`, "-jar", jar, "nogui"];
    extraEnv = {};
    engine = "java";
    pushLog(rt, `[HoptoNode] Java ${jar} · ${vars.MC_VERSION || "?"} · heap ${heap} MB`, "system");
  } else if (jar && !commandExists("java")) {
    pushLog(rt, "[HoptoNode] JAR var ama Java yok. Docker imajı güncellenene kadar bekleyin.", "stderr");
  } else if (phpPhar) {
    const bundled = findBundledPhp(dir);
    if (bundled) {
      try {
        fs.chmodSync(bundled, 0o755);
      } catch {
        /* */
      }
      cmd = bundled;
      args = [phpPhar, "--no-wizard", "--disable-ansi"];
      extraEnv = { LD_LIBRARY_PATH: path.dirname(bundled) };
      engine = "php-pm";
      pushLog(rt, `[HoptoNode] PocketMine PHP: ${bundled}`, "system");
    } else if (commandExists("php")) {
      cmd = "php";
      args = [phpPhar, "--no-wizard", "--disable-ansi"];
      extraEnv = {};
      engine = "php";
      pushLog(rt, "[HoptoNode] Sistem PHP pthreads içermez. Eski PHAR düşer.", "system");
      pushLog(rt, "[HoptoNode] Linux bin/ klasörünü (bin/php7/bin/php) zipleyip Dosyalar'a yükle, sonra yeniden başlat.", "system");
    } else {
      pushLog(rt, "[HoptoNode] PHP yok, PHAR çalıştırılamadı.", "stderr");
    }
  } else if (bedrockBin) {
    cmd = path.join(dir, "bedrock_server");
    args = [];
    extraEnv = { LD_LIBRARY_PATH: "." };
    engine = "bedrock";
  } else {
    pushLog(rt, "[HoptoNode] Dahili oyun motoru başlatılıyor (port dinleniyor, konsol açık).", "system");
  }

  try {
    const child = spawn(cmd, args, {
      cwd: dir,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    rt.child = child;
    rt.engine = engine;
    rt.status = "running";
    sampleLoop(rt);
    pushLog(rt, `[HoptoNode] süreç ${child.pid} · motor ${engine}`, "system");

    const onChunk = (stream) => (buf) => {
      String(buf)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => pushLog(rt, line, stream));
    };
    child.stdout.on("data", onChunk("stdout"));
    child.stderr.on("data", onChunk("stderr"));
    child.on("exit", (code, signal) => {
      rt.status = "offline";
      rt.child = null;
      pushLog(rt, `[HoptoNode] süreç durdu (kod ${code ?? "—"}, ${signal || "sinyal yok"})`, "system");
    });
    child.on("error", (err) => {
      rt.status = "offline";
      rt.child = null;
      pushLog(rt, `[HoptoNode] başlatılamadı: ${err.message}`, "stderr");
    });
  } catch (err) {
    rt.status = "offline";
    pushLog(rt, `[HoptoNode] hata: ${err.message}`, "stderr");
    throw err;
  }
  return rt;
}

function commandExists(bin) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

function sendCommand(id, command) {
  const rt = runtimes.get(id);
  if (!rt || !rt.child || !rt.child.stdin || !rt.child.stdin.writable) {
    throw new Error("Konsol bağlı değil — önce sunucuyu başlat");
  }
  pushLog(rt, `> ${command}`, "stdin");
  rt.child.stdin.write(String(command) + "\n");
}

function stopServer(id, signal = "SIGTERM") {
  const rt = runtimes.get(id);
  if (!rt || !rt.child) {
    if (rt) rt.status = "offline";
    return;
  }
  rt.status = "stopping";
  pushLog(rt, "[HoptoNode] durduruluyor…", "system");
  try {
    if (rt.child.stdin.writable) rt.child.stdin.write("stop\n");
  } catch {
    /* ignore */
  }
  const child = rt.child;
  setTimeout(() => {
    if (child && rt.child === child) {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    }
  }, signal === "SIGKILL" ? 200 : 3500);
}

function statusOf(id) {
  const rt = runtimes.get(id);
  return rt ? rt.status : "offline";
}

function subscribe(id, fn) {
  const rt = ensureRt(id);
  rt.listeners.add(fn);
  return () => rt.listeners.delete(fn);
}

function statsOf(server) {
  const rt = ensureRt(server.id);
  const dir = serverDir(server.id);
  const last = rt.samples[rt.samples.length - 1] || { cpu: 0, mem: 0 };
  return {
    status: rt.status,
    engine: rt.engine,
    pid: rt.child ? rt.child.pid : null,
    uptime: rt.startedAt && rt.status !== "offline" ? Date.now() - rt.startedAt : 0,
    cpu: last.cpu,
    memoryMb: last.mem,
    memoryLimitMb: server.memoryMb,
    diskBytes: fs.existsSync(dir) ? diskUsage(dir) : 0,
    diskLimitMb: server.diskMb,
    players: rt.players || 0,
    samples: rt.samples.slice(-30),
  };
}

function createBackup(server, name) {
  const { spawnSync } = require("child_process");
  const dir = ensureServerFiles(server);
  const backups = path.join(dir, "backups");
  fs.mkdirSync(backups, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const file = `${id}.tar.gz`;
  const r = spawnSync(
    "tar",
    ["-czf", path.join(backups, file), "--exclude=backups", "."],
    { cwd: dir, encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(r.stderr || "Yedek alınamadı");
  const st = fs.statSync(path.join(backups, file));
  return {
    id,
    file,
    name: name || `yedek-${new Date().toISOString().slice(0, 16)}`,
    size: st.size,
    createdAt: new Date().toISOString(),
  };
}

function backupIdOf(file) {
  return String(file).replace(/\.(tar\.gz|tgz|zip|tar)$/i, "");
}

function findBackupFile(server, backupId) {
  const dir = path.join(serverDir(server.id), "backups");
  const id = String(backupId);
  if (!fs.existsSync(dir)) return null;
  const names = [id + ".tar.gz", id + ".tgz", id + ".zip", id + ".tar", id];
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  const hit = fs.readdirSync(dir).find((f) => f === id || backupIdOf(f) === id);
  return hit ? path.join(dir, hit) : null;
}

function listBackups(server) {
  const dir = path.join(serverDir(server.id), "backups");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(tar\.gz|tgz|zip|tar)$/i.test(f))
    .map((file) => {
      const st = fs.statSync(path.join(dir, file));
      return { id: backupIdOf(file), file, size: st.size, createdAt: st.mtime.toISOString(), name: file };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function restoreBackup(server, backupId) {
  if (statusOf(server.id) === "running") throw new Error("Önce sunucuyu durdur");
  const dir = serverDir(server.id);
  const file = findBackupFile(server, backupId);
  if (!file) throw new Error("Yedek yok");
  extractArchiveFile(file, dir);
}

function deleteBackup(server, backupId) {
  const file = findBackupFile(server, backupId);
  if (file && fs.existsSync(file)) fs.unlinkSync(file);
}

function backupFile(server, backupId) {
  return findBackupFile(server, backupId);
}

function writeListenPort(dir, port) {
  const f = path.join(dir, "server.properties");
  if (!fs.existsSync(f)) return;
  let t = fs.readFileSync(f, "utf8");
  if (/^server-port=/m.test(t)) t = t.replace(/^server-port=.*/m, "server-port=" + port);
  else t += "\nserver-port=" + port + "\n";
  if (/^server-portv6=/m.test(t)) t = t.replace(/^server-portv6=.*/m, "server-portv6=" + port);
  fs.writeFileSync(f, t);
}

function stopOthersOfProtocol() {}

function extractArchiveFile(archiveAbs, destDir) {
  const { spawnSync } = require("child_process");
  const name = archiveAbs.toLowerCase();
  fs.mkdirSync(destDir, { recursive: true });
  let r;
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
    r = spawnSync("tar", ["-xzf", archiveAbs, "-C", destDir, "--exclude=backups"], { encoding: "utf8" });
  } else if (name.endsWith(".tar")) {
    r = spawnSync("tar", ["-xf", archiveAbs, "-C", destDir, "--exclude=backups"], { encoding: "utf8" });
  } else if (name.endsWith(".zip")) {
    r = spawnSync("unzip", ["-o", archiveAbs, "-d", destDir, "-x", "backups/*"], { encoding: "utf8" });
    if (r.status !== 0) {
      r = spawnSync(
        "python3",
        ["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", archiveAbs, destDir],
        { encoding: "utf8" }
      );
    }
  } else {
    throw new Error("Desteklenmeyen arşiv (zip / tar.gz)");
  }
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "çıkarma başarısız").slice(0, 300));
  return true;
}

function unpackServerArchive(server, relPath) {
  const root = ensureServerFiles(server);
  const abs = safeJoin(root, relPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error("Arşiv yok");
  extractArchiveFile(abs, path.dirname(abs));
  return path.basename(abs);
}

function archiveFiles(server, relPaths) {
  const { spawnSync } = require("child_process");
  const root = ensureServerFiles(server);
  const names = (relPaths || []).map((p) => String(p || "").replace(/^\/+/, "")).filter(Boolean);
  if (!names.length) throw new Error("Dosya seçilmedi");
  const safe = [];
  for (const n of names) {
    const abs = safeJoin(root, n);
    if (!fs.existsSync(abs)) continue;
    safe.push(path.relative(root, abs) || ".");
  }
  if (!safe.length) throw new Error("Seçilen dosya yok");
  const tmp = path.join(os.tmpdir(), "hn-arc-" + Date.now() + ".tar.gz");
  const r = spawnSync("tar", ["-czf", tmp, ...safe], { cwd: root, encoding: "utf8" });
  if (r.status !== 0 || !fs.existsSync(tmp)) throw new Error(r.stderr || "Arşiv alınamadı");
  return tmp;
}

module.exports = {
  SERVERS_ROOT,
  serverDir,
  safeJoin,
  ensureServerFiles,
  startServer,
  stopServer,
  sendCommand,
  statusOf,
  getRuntime,
  subscribe,
  statsOf,
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  backupFile,
  writeListenPort,
  diskUsage,
  stopOthersOfProtocol,
  archiveFiles,
  extractArchiveFile,
  unpackServerArchive,
};
