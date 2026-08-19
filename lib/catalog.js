"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { getEgg } = require("./eggs");

const UA = "HoptiNode/1.0 (https://hoptinode.onrender.com)";
let poggitCache = { at: 0, items: [] };

function httpGet(url, binary = false) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 6) return reject(new Error("çok fazla yönlendirme"));
      https
        .get(u, { headers: { "User-Agent": UA, Accept: "application/json" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return go(res.headers.location, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("indirme " + res.statusCode));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const buf = Buffer.concat(chunks);
            resolve(binary ? buf : buf.toString("utf8"));
          });
        })
        .on("error", reject);
    };
    go(url, 0);
  });
}

function kindFor(egg) {
  if (!egg) return "mods";
  if (["pocketmine", "nukkit", "bedrock"].includes(egg.id)) return "plugins";
  if (egg.id === "paper" || egg.id === "vanilla-java") return "plugins";
  return "mods";
}

function folderFor(egg) {
  return kindFor(egg) === "plugins" ? "plugins" : "mods";
}

function loaderFor(egg) {
  if (!egg) return "fabric";
  if (egg.id === "forge") return "forge";
  if (egg.id === "neoforge") return "neoforge";
  if (egg.id === "quilt") return "quilt";
  if (egg.id === "paper" || egg.id === "vanilla-java") return "paper";
  return "fabric";
}

async function searchModrinth(query, egg, gameVersion) {
  const loader = loaderFor(egg);
  const type = kindFor(egg) === "plugins" && (egg.id === "paper" || egg.id === "vanilla-java") ? "plugin" : "mod";
  const facets = [[`project_type:${type}`], [`categories:${loader}`]];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  const url =
    "https://api.modrinth.com/v2/search?limit=20&index=relevance&query=" +
    encodeURIComponent(query || "") +
    "&facets=" +
    encodeURIComponent(JSON.stringify(facets));
  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  return (data.hits || []).map((h) => ({
    source: "modrinth",
    id: h.project_id || h.slug,
    slug: h.slug,
    name: h.title,
    description: h.description,
    downloads: h.downloads,
    author: (h.author || "").toString(),
    icon: h.icon_url || "",
    version: (h.latest_version || "").toString(),
  }));
}

async function searchPoggit(query) {
  const now = Date.now();
  if (!poggitCache.items.length || now - poggitCache.at > 15 * 60 * 1000) {
    const raw = await httpGet("https://poggit.pmmp.io/releases.min.json");
    const list = JSON.parse(raw);
    poggitCache = { at: now, items: Array.isArray(list) ? list : [] };
  }
  const q = String(query || "").toLowerCase();
  const seen = new Set();
  const out = [];
  for (const p of poggitCache.items) {
    const name = String(p.name || "");
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (q && !key.includes(q) && !String(p.tagline || "").toLowerCase().includes(q)) continue;
    seen.add(key);
    out.push({
      source: "poggit",
      id: name,
      slug: name,
      name,
      description: p.tagline || p.description || "",
      downloads: p.downloads || 0,
      author: (p.producer || p.author || "gönüllü").toString(),
      icon: "",
      version: p.version || "",
      url: p.artifact_url || p.url || "",
    });
    if (out.length >= 20) break;
  }
  return out;
}

async function search(query, server) {
  const egg = getEgg(server.eggId);
  try {
    if (["pocketmine", "nukkit", "bedrock"].includes(egg && egg.id)) {
      return await searchPoggit(query);
    }
    const ver = (server.env && server.env.MC_VERSION) || "";
    let hits = await searchModrinth(query, egg, ver);
    if (!hits.length && ver) hits = await searchModrinth(query, egg, "");
    return hits;
  } catch (err) {
    throw new Error("Arama başarısız: " + err.message);
  }
}

async function installModrinth(server, projectId) {
  const egg = getEgg(server.eggId);
  const loader = loaderFor(egg);
  const ver = (server.env && server.env.MC_VERSION) || "";
  let url =
    "https://api.modrinth.com/v2/project/" +
    encodeURIComponent(projectId) +
    "/version?loaders=" +
    encodeURIComponent(JSON.stringify([loader]));
  if (ver) url += "&game_versions=" + encodeURIComponent(JSON.stringify([ver]));
  let versions = JSON.parse(await httpGet(url));
  if (!Array.isArray(versions) || !versions.length) {
    versions = JSON.parse(
      await httpGet("https://api.modrinth.com/v2/project/" + encodeURIComponent(projectId) + "/version")
    );
  }
  if (!versions.length) throw new Error("Uyumlu sürüm yok");
  const file = (versions[0].files || []).find((f) => f.primary) || (versions[0].files || [])[0];
  if (!file || !file.url) throw new Error("Dosya yok");
  const buf = await httpGet(file.url, true);
  const dir = path.join(require("./runtime").serverDir(server.id), folderFor(egg));
  fs.mkdirSync(dir, { recursive: true });
  const name = path.basename(file.filename || file.url).replace(/[^a-zA-Z0-9._-]/g, "_");
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, size: buf.length, version: versions[0].version_number };
}

async function installPoggit(server, name) {
  if (!poggitCache.items.length) await searchPoggit(name);
  const hit = poggitCache.items.find((p) => String(p.name).toLowerCase() === String(name).toLowerCase());
  const url = hit && (hit.artifact_url || (hit.artifactId ? "https://poggit.pmmp.io/r/" + hit.artifactId : null));
  if (!url) throw new Error("Eklenti bulunamadı");
  const buf = await httpGet(url, true);
  const dir = path.join(require("./runtime").serverDir(server.id), "plugins");
  fs.mkdirSync(dir, { recursive: true });
  const fname = String(hit.name || name).replace(/[^a-zA-Z0-9._-]/g, "_") + ".phar";
  fs.writeFileSync(path.join(dir, fname), buf);
  return { name: fname, size: buf.length, version: hit.version };
}

async function install(server, source, id) {
  if (source === "poggit") return installPoggit(server, id);
  return installModrinth(server, id);
}

function listInstalled(server) {
  const egg = getEgg(server.eggId);
  const folder = folderFor(egg);
  const dir = path.join(require("./runtime").serverDir(server.id), folder);
  if (!fs.existsSync(dir)) return { folder, items: [] };
  const items = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, mtime: st.mtime.toISOString(), folder };
    });
  return { folder, items };
}

function removeInstalled(server, name) {
  const egg = getEgg(server.eggId);
  const dir = path.join(require("./runtime").serverDir(server.id), folderFor(egg));
  const target = path.join(dir, path.basename(name));
  if (!target.startsWith(path.resolve(dir))) throw new Error("Geçersiz yol");
  if (!fs.existsSync(target)) throw new Error("Dosya yok");
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { search, install, listInstalled, removeInstalled, kindFor, folderFor };
