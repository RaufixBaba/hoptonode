const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const { Collection } = require("./store");

const users = new Collection("users", []);
const servers = new Collection("servers", []);
const sessions = new Collection("sessions", []);
const settings = new Collection("settings", {
  brand: "HoptoNode",
  tagline: "Oyun sunucuların, tek panelde.",
  registrationOpen: true,
  defaultRamMb: 2048,
  defaultCpuPercent: 100,
  defaultDiskMb: 10240,
  maxRamMbUser: 8192,
  maxCpuPercentUser: 200,
  staffUnlimited: true,
  motd: "HoptoNode ağına hoş geldin.",
});
const audit = new Collection("audit", []);

function ensureSeed() {
  const list = users.all();
  if (list.length) return { seeded: false };

  const now = new Date().toISOString();
  const founderPass = "Kurucu#2026";
  const adminPass = "Admin#2026";

  const founder = {
    id: nanoid(12),
    username: "kurucu",
    email: "kurucu@hoptonode.local",
    displayName: "Kurucu",
    role: "founder",
    passwordHash: bcrypt.hashSync(founderPass, 10),
    createdAt: now,
    ramQuotaMb: 0,
    cpuQuota: 0,
    diskQuotaMb: 0,
    unlimited: true,
    banned: false,
  };

  const admin = {
    id: nanoid(12),
    username: "arkadas",
    email: "admin@hoptonode.local",
    displayName: "Yönetici",
    role: "admin",
    passwordHash: bcrypt.hashSync(adminPass, 10),
    createdAt: now,
    ramQuotaMb: 0,
    cpuQuota: 0,
    diskQuotaMb: 0,
    unlimited: true,
    banned: false,
  };

  users.save([founder, admin]);
  settings.all();
  servers.all();
  sessions.all();
  audit.save([
    {
      id: nanoid(10),
      at: now,
      actor: "system",
      action: "seed",
      detail: "Kurucu ve yönetici hesapları oluşturuldu.",
    },
  ]);

  return {
    seeded: true,
    founder: { username: founder.username, password: founderPass },
    admin: { username: admin.username, password: adminPass },
  };
}

module.exports = { users, servers, sessions, settings, audit, ensureSeed };
