const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir(path.dirname(file));
  if (!fs.existsSync(file)) {
    writeJson(file, fallback);
    return structuredClone(fallback);
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class Collection {
  constructor(name, fallback) {
    this.file = path.join(DATA_DIR, `${name}.json`);
    this.fallback = fallback;
  }

  all() {
    return readJson(this.file, this.fallback);
  }

  save(data) {
    writeJson(this.file, data);
  }

  update(mutator) {
    const data = this.all();
    const next = mutator(data) ?? data;
    this.save(next);
    return next;
  }
}

module.exports = { DATA_DIR, ensureDir, readJson, writeJson, Collection };
