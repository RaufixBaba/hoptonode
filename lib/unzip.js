const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

function detectKind(filePath, nameHint = "") {
  const hint = String(nameHint || filePath || "").toLowerCase();
  let head = Buffer.alloc(512);
  try {
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, head, 0, 512, 0);
    fs.closeSync(fd);
  } catch {
    head = Buffer.alloc(0);
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b) return "zip";
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (head.length >= 262 && head.slice(257, 262).toString("utf8") === "ustar") return "tar";
  if (/\.zip$|\.mcworld$|\.mcpack$/i.test(hint)) return "zip";
  if (/\.tar\.gz$|\.tgz$/i.test(hint)) return "gzip";
  if (/\.tar$/i.test(hint)) return "tar";
  return "";
}

function safeJoin(root, rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").some((p) => p === ".." || p === "")) return null;
  const resolved = path.resolve(root, clean);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function unzipNode(zipPath, destDir) {
  const data = fs.readFileSync(zipPath);
  let eocd = -1;
  const min = Math.max(0, data.length - 22 - 65557);
  for (let i = data.length - 22; i >= min; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip bozuk (EOCD yok)");
  const count = data.readUInt16LE(eocd + 10);
  let cdOff = data.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error("zip64");
  let written = 0;
  for (let n = 0; n < count; n++) {
    if (cdOff + 46 > data.length || data.readUInt32LE(cdOff) !== 0x02014b50) throw new Error("zip dizin bozuk");
    const method = data.readUInt16LE(cdOff + 10);
    const flags = data.readUInt16LE(cdOff + 8);
    const compSize = data.readUInt32LE(cdOff + 20);
    const fnLen = data.readUInt16LE(cdOff + 28);
    const extraLen = data.readUInt16LE(cdOff + 30);
    const commentLen = data.readUInt16LE(cdOff + 32);
    const localOff = data.readUInt32LE(cdOff + 42);
    const name = data.slice(cdOff + 46, cdOff + 46 + fnLen).toString("utf8").replace(/\\/g, "/");
    cdOff += 46 + fnLen + extraLen + commentLen;
    if (!name || name.startsWith("__MACOSX") || name.includes("..")) continue;
    if (name === "backups" || name.startsWith("backups/")) continue;
    if (flags & 1) throw new Error("şifreli zip desteklenmez");
    const dest = name.endsWith("/") ? safeJoin(destDir, name.slice(0, -1)) : safeJoin(destDir, name);
    if (!dest) continue;
    if (name.endsWith("/")) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    if (localOff + 30 > data.length || data.readUInt32LE(localOff) !== 0x04034b50) throw new Error("zip kayıt bozuk");
    const localFn = data.readUInt16LE(localOff + 26);
    const localEx = data.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localFn + localEx;
    const comp = data.subarray(start, start + compSize);
    let out;
    if (method === 0) out = comp;
    else if (method === 8) out = zlib.inflateRawSync(comp);
    else throw new Error("zip metod " + method);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, out);
    written += 1;
  }
  if (!written) throw new Error("zip boş");
  return written;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function extractArchive(archiveAbs, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const kind = detectKind(archiveAbs, path.basename(archiveAbs));
  if (!kind) throw new Error("Bu bir zip / tar.gz değil");
  const errors = [];
  if (kind === "zip") {
    const u = run("unzip", ["-o", "-q", archiveAbs, "-d", destDir, "-x", "backups/*", "__MACOSX/*"]);
    if (u.status === 0) return hoistIfWrapped(destDir);
    errors.push(u.stderr || u.stdout || "unzip");
    try {
      unzipNode(archiveAbs, destDir);
      return hoistIfWrapped(destDir);
    } catch (err) {
      errors.push(String(err.message || err));
    }
    const p = run("python3", [
      "-c",
      "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      archiveAbs,
      destDir,
    ]);
    if (p.status === 0) return hoistIfWrapped(destDir);
    errors.push(p.stderr || "python zip");
    throw new Error(errors.filter(Boolean).join(" · ").slice(0, 280));
  }
  if (kind === "gzip") {
    let r = run("tar", ["-xzf", archiveAbs, "-C", destDir, "--exclude=backups", "--exclude=__MACOSX"]);
    if (r.status === 0) return hoistIfWrapped(destDir);
    r = run("tar", ["-xzf", archiveAbs, "-C", destDir]);
    if (r.status === 0) return hoistIfWrapped(destDir);
    throw new Error((r.stderr || r.stdout || "tar.gz açılamadı").slice(0, 280));
  }
  const r = run("tar", ["-xf", archiveAbs, "-C", destDir, "--exclude=backups"]);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "tar açılamadı").slice(0, 280));
  return hoistIfWrapped(destDir);
}

function looksLikeServer(dir) {
  const marks = [
    "server.properties",
    "PocketMine-MP.phar",
    "server.jar",
    "paper.jar",
    "pocketmine.yml",
    "nukkit.yml",
    "worlds",
    "world",
    "plugins",
    "mods",
    "eula.txt",
    "fabric-server-launch.jar",
  ];
  try {
    const names = fs.readdirSync(dir);
    return names.some((n) => marks.includes(n));
  } catch {
    return false;
  }
}

function hoistIfWrapped(destDir) {
  let ents = [];
  try {
    ents = fs.readdirSync(destDir).filter((n) => n !== "__MACOSX" && n !== ".DS_Store" && n !== "backups");
  } catch {
    return destDir;
  }
  if (ents.length !== 1) return destDir;
  const only = path.join(destDir, ents[0]);
  let st;
  try {
    st = fs.statSync(only);
  } catch {
    return destDir;
  }
  if (!st.isDirectory() || !looksLikeServer(only)) return destDir;
  for (const n of fs.readdirSync(only)) {
    if (n === "backups") continue;
    const from = path.join(only, n);
    const to = path.join(destDir, n);
    try {
      fs.rmSync(to, { recursive: true, force: true });
    } catch {
      /* */
    }
    fs.renameSync(from, to);
  }
  try {
    fs.rmSync(only, { recursive: true, force: true });
  } catch {
    /* */
  }
  return destDir;
}

function chmodBins(dir, depth = 0) {
  if (depth > 6) return;
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) chmodBins(full, depth + 1);
    else if (e.name === "php" || e.name === "bedrock_server" || e.name.endsWith(".so")) {
      try {
        fs.chmodSync(full, 0o755);
      } catch {
        /* */
      }
    }
  }
}

module.exports = { detectKind, extractArchive, unzipNode, hoistIfWrapped, chmodBins };
