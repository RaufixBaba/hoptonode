#!/usr/bin/env node
"use strict";

const net = require("net");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const cfg = {
  name: process.env.HN_NAME || "HoptoNode",
  port: Number(process.env.HN_PORT || 25565),
  protocol: process.env.HN_PROTOCOL || "java",
  motd: process.env.HN_MOTD || "A Minecraft Server",
  maxPlayers: Number(process.env.HN_MAX_PLAYERS || 20),
  version: process.env.HN_VERSION || "1.21.4",
  egg: process.env.HN_EGG || "paper",
  dir: process.env.HN_DIR || process.cwd(),
};

const state = {
  started: Date.now(),
  players: [],
  ops: [],
  whitelist: [],
  banned: [],
  difficulty: "normal",
  gamemode: "survival",
  tps: 20,
  saving: false,
  tcp: null,
  udp: null,
};

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
function log(line) {
  const out = `[${ts()}] ${line}`;
  process.stdout.write(out + "\n");
  try {
    fs.mkdirSync(path.join(cfg.dir, "logs"), { recursive: true });
    fs.appendFileSync(path.join(cfg.dir, "logs", "latest.log"), out + "\n");
  } catch {
    /* ignore */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.dir, file), "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(path.join(cfg.dir, file), JSON.stringify(data, null, 2));
}

function writeVarInt(value) {
  const out = [];
  let v = value >>> 0;
  while (true) {
    if ((v & ~0x7f) === 0) {
      out.push(v);
      break;
    }
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(out);
}
function readVarInt(buf, offset) {
  let num = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    num |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: num, offset: i };
    shift += 7;
    if (shift > 35) throw new Error("varint");
  }
  return null;
}
function writeString(str) {
  const data = Buffer.from(str, "utf8");
  return Buffer.concat([writeVarInt(data.length), data]);
}
function pack(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload || Buffer.alloc(0)]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function statusJson() {
  return {
    version: { name: `HoptoNode ${cfg.egg} ${cfg.version}`, protocol: 769 },
    players: {
      max: cfg.maxPlayers,
      online: state.players.length,
      sample: state.players.slice(0, 12).map((n) => ({ name: n, id: "00000000-0000-0000-0000-000000000000" })),
    },
    description: { text: cfg.motd },
    enforcesSecureChat: false,
  };
}

function handleJavaConn(socket) {
  let buf = Buffer.alloc(0);
  let stage = "hand";
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length) {
      const len = readVarInt(buf, 0);
      if (!len) return;
      if (buf.length < len.offset + len.value) return;
      const frame = buf.subarray(len.offset, len.offset + len.value);
      buf = buf.subarray(len.offset + len.value);
      const pid = readVarInt(frame, 0);
      if (!pid) return;
      if (stage === "hand" && pid.value === 0) {
        let o = pid.offset;
        const proto = readVarInt(frame, o);
        if (!proto) return;
        o = proto.offset;
        const slen = readVarInt(frame, o);
        if (!slen) return;
        o = slen.offset + slen.value;
        o += 2;
        const next = readVarInt(frame, o);
        stage = next && next.value === 2 ? "login" : "status";
      } else if (stage === "status" && pid.value === 0) {
        socket.write(pack(0x00, writeString(JSON.stringify(statusJson()))));
      } else if (stage === "status" && pid.value === 1) {
        const payload = frame.subarray(pid.offset);
        socket.write(pack(0x01, payload));
      } else if (stage === "login" && pid.value === 0) {
        socket.write(
          pack(
            0x00,
            writeString(
              JSON.stringify({
                text: "",
                extra: [
                  { text: "HoptoNode\n", color: "aqua", bold: true },
                  { text: `${cfg.name} çevrimiçi.\n`, color: "white" },
                  { text: "Durum pingi açık. Tam dünya oturumu için JAR yükleyin.", color: "gray" },
                ],
              })
            )
          )
        );
        socket.end();
      }
    }
  });
  socket.on("error", () => {});
}

const BEDROCK_MAGIC = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");

function bedrockPong() {
  const id = [
    "MCPE",
    cfg.motd.replace(/;/g, ","),
    "818",
    cfg.version,
    String(state.players.length),
    String(cfg.maxPlayers),
    "13253860892328930865",
    cfg.name.replace(/;/g, ","),
    "Survival",
    "1",
    String(cfg.port),
    String(cfg.port),
  ].join(";");
  const nameBuf = Buffer.from(id, "utf8");
  const out = Buffer.alloc(1 + 8 + 8 + 16 + 2 + nameBuf.length);
  let o = 0;
  out[o++] = 0x1c;
  out.writeBigUInt64LE(0n, o);
  o += 8;
  out.writeBigUInt64LE(13253860892328930865n, o);
  o += 8;
  BEDROCK_MAGIC.copy(out, o);
  o += 16;
  out.writeUInt16BE(nameBuf.length, o);
  o += 2;
  nameBuf.copy(out, o);
  return out;
}

function saveAll() {
  state.saving = true;
  fs.mkdirSync(path.join(cfg.dir, "world"), { recursive: true });
  writeJson("ops.json", state.ops.map((name) => ({ name, level: 4, bypassesPlayerLimit: true })));
  writeJson("whitelist.json", state.whitelist.map((name) => ({ name })));
  writeJson("banned-players.json", state.banned.map((name) => ({ name, created: ts(), reason: "Banned" })));
  fs.writeFileSync(
    path.join(cfg.dir, "usercache.json"),
    JSON.stringify(state.players.map((name) => ({ name, expiresOn: "2099-01-01 00:00:00 +0000" })), null, 2)
  );
  fs.writeFileSync(
    path.join(cfg.dir, "world", "session.lock"),
    `HoptoNode ${cfg.name} ${ts()}\n`
  );
  state.saving = false;
}

function handleCommand(raw) {
  const line = String(raw || "").trim();
  if (!line) return;
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ");
  const c = cmd.toLowerCase();
  if (c === "help") {
    log("help: say, list, stop, version, motd, whitelist, op, deop, difficulty, save-all, plugins, tps, kick, ban");
  } else if (c === "say") {
    log(`[Server] ${arg}`);
  } else if (c === "list") {
    log(`There are ${state.players.length} of a max of ${cfg.maxPlayers} players online: ${state.players.join(", ")}`);
  } else if (c === "stop" || c === "end") {
    log("Stopping the server");
    shutdown(0);
  } else if (c === "version") {
    log(`This server is running HoptoNode ${cfg.egg} ${cfg.version}`);
  } else if (c === "motd") {
    if (arg) {
      cfg.motd = arg;
      log(`MOTD set to '${cfg.motd}'`);
    } else log(cfg.motd);
  } else if (c === "op") {
    if (!arg) return log("Usage: op <player>");
    if (!state.ops.includes(arg)) state.ops.push(arg);
    log(`Made ${arg} a server operator`);
    saveAll();
  } else if (c === "deop") {
    state.ops = state.ops.filter((n) => n !== arg);
    log(`Made ${arg} no longer a server operator`);
  } else if (c === "whitelist") {
    const sub = rest[0];
    const name = rest.slice(1).join(" ");
    if (sub === "add" && name) {
      state.whitelist.push(name);
      log(`Added ${name} to the whitelist`);
    } else if (sub === "remove") {
      state.whitelist = state.whitelist.filter((n) => n !== name);
      log(`Removed ${name} from the whitelist`);
    } else log(`Whitelist (${state.whitelist.length}): ${state.whitelist.join(", ") || "empty"}`);
  } else if (c === "difficulty") {
    if (arg) state.difficulty = arg;
    log(`Difficulty: ${state.difficulty}`);
  } else if (c === "save-all" || c === "save") {
    saveAll();
    log("Saved the game");
  } else if (c === "plugins") {
    const plugDir = path.join(cfg.dir, "plugins");
    const modsDir = path.join(cfg.dir, "mods");
    const plugs = fs.existsSync(plugDir) ? fs.readdirSync(plugDir).filter((f) => !f.startsWith(".")) : [];
    const mods = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => !f.startsWith(".")) : [];
    log(`Plugins (${plugs.length}): ${plugs.join(", ") || "none"}`);
    if (mods.length) log(`Mods (${mods.length}): ${mods.join(", ")}`);
  } else if (c === "tps") {
    log(`TPS from last 1m, 5m, 15m: ${state.tps.toFixed(2)}, ${state.tps.toFixed(2)}, ${state.tps.toFixed(2)}`);
  } else if (c === "memory") {
    const m = process.memoryUsage();
    log(`Heap ${Math.round(m.heapUsed / 1024 / 1024)} MB / RSS ${Math.round(m.rss / 1024 / 1024)} MB`);
  } else if (c === "kick") {
    log(arg ? `Kicked ${arg}` : "Usage: kick <player>");
  } else if (c === "ban") {
    if (!arg) return log("Usage: ban <player>");
    state.banned.push(arg);
    log(`Banned ${arg}`);
  } else if (c === "pardon") {
    state.banned = state.banned.filter((n) => n !== arg);
    log(`Unbanned ${arg}`);
  } else if (c === "reload") {
    log("Reloading!");
    log("Reload complete.");
  } else {
    log(`Unknown command. Type "help" for help.`);
  }
}

function shutdown(code) {
  try {
    if (state.tcp) state.tcp.close();
    if (state.udp) state.udp.close();
  } catch {
    /* */
  }
  saveAll();
  log("HoptoNode thread dumped.");
  process.exit(code);
}

function boot() {
  state.ops = (readJson("ops.json", []) || []).map((x) => x.name || x).filter(Boolean);
  state.whitelist = (readJson("whitelist.json", []) || []).map((x) => x.name || x).filter(Boolean);

  log(`Starting minecraft server version ${cfg.version}`);
  log(`Loading properties`);
  log(`Default game type: ${state.gamemode.toUpperCase()}`);
  log(`Generating keypair`);
  log(`Starting Minecraft server on *: ${cfg.port}`);
  log(`Preparing level "world"`);
  log(`Preparing start region for dimension minecraft:overworld`);
  log(`Time elapsed: ${120 + Math.floor(Math.random() * 400)} ms`);
  log(`Done! For help, type "help"`);
  log(`HoptoNode runtime · ${cfg.egg} · ${cfg.name}`);

  if (cfg.protocol === "bedrock") {
    const udp = dgram.createSocket("udp4");
    udp.on("message", (msg, rinfo) => {
      if (!msg.length) return;
      if (msg.length > 6 && msg.subarray(0, 6).toString("ascii") === "PROXY ") {
        const nl = msg.indexOf(10);
        if (nl !== -1) msg = msg.subarray(nl + 1);
      }
      if (!msg.length) return;
      if (msg[0] === 0x01 || msg[0] === 0x05) {
        udp.send(bedrockPong(), rinfo.port, rinfo.address);
      }
    });
    udp.on("error", (err) => log(`UDP error: ${err.message}`));
    udp.bind(cfg.port, "0.0.0.0", () => log(`RakNet listener bound ${cfg.port}`));
    state.udp = udp;
  } else {
    const tcp = net.createServer(handleJavaConn);
    tcp.on("error", (err) => {
      log(`**** FAILED TO BIND TO PORT!`);
      log(`The exception was: ${err.message}`);
      shutdown(1);
    });
    tcp.listen(cfg.port, "0.0.0.0", () => log(`Query running on 0.0.0.0:${cfg.port}`));
    state.tcp = tcp;
  }

  saveAll();
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", handleCommand);
process.on("SIGTERM", () => handleCommand("stop"));
process.on("SIGINT", () => handleCommand("stop"));

boot();
