const $ = (sel, root = document) => root.querySelector(sel);
const TOKEN_KEY = "hn_token";

function siteBase() {
  let p = location.pathname || "/";
  if (p.endsWith("index.html")) p = p.slice(0, -10);
  if (!p.endsWith("/")) {
    const last = p.split("/").pop() || "";
    p = last.includes(".") ? p.replace(/[^/]+$/, "") : p + "/";
  }
  return p;
}
function asset(p) {
  return siteBase() + String(p).replace(/^\//, "");
}

const state = {
  me: null,
  meta: null,
  eggs: [],
  servers: [],
  activity: [],
  view: null,
  tab: "console",
  filePath: ".",
  ws: null,
  pickedEgg: "paper",
  wizard: 1,
  poll: null,
};

function token() {
  return localStorage.getItem(TOKEN_KEY) || "";
}
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2800);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (!opts.raw) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = "Bearer " + token();
  if (window.HN_STATIC && window.hnMock) {
    try {
      return await window.hnMock(path, { ...opts, headers });
    } catch (err) {
      if (String(err.message).includes("Oturum")) {
        setToken("");
        state.me = null;
        location.hash = "#/login";
      }
      throw err;
    }
  }
  const res = await fetch(path, {
    credentials: "same-origin",
    ...opts,
    headers,
    body: opts.body && !opts.raw && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth") && path !== "/api/meta") {
    setToken("");
    state.me = null;
    location.hash = "#/login";
    throw new Error("Oturum kapandı, tekrar giriş yap");
  }
  if (!res.ok) throw new Error(data.error || "İstek başarısız");
  return data;
}

const staff = () => state.me && ["founder", "admin"].includes(state.me.role);
const roleLabel = (r) => ({ founder: "kurucu", admin: "yönetici", user: "üye" }[r] || r);
const statusLabel = (s) => ({ offline: "kapalı", starting: "açılıyor", running: "çalışıyor", stopping: "duruyor" }[s] || s);
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function fmtUp(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}s ${m}dk` : `${m}dk ${s % 60}sn`;
}

function hash() {
  return location.hash || "#/";
}

function closeWs() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {
      /* */
    }
    state.ws = null;
  }
}
function stopPoll() {
  if (state.poll) {
    clearInterval(state.poll);
    state.poll = null;
  }
}

function navItems() {
  const h = hash();
  const items = [
    ["#/", "Gösterge"],
    ["#/servers", "Sunucular"],
    ["#/create", "Sunucu oluştur"],
    ["#/account", "Hesap"],
  ];
  if (staff()) items.push(["#/admin", "Yönetim"]);
  return items
    .map(([href, label]) => {
      const on = href === "#/" ? h === "#/" || h === "#" : h.startsWith(href);
      return `<a href="${href}" class="${on ? "active" : ""}">${label}</a>`;
    })
    .join("");
}

function subNav(id) {
  const tabs = [
    ["console", "Konsol"],
    ["files", "Dosyalar"],
    ["content", "Mod / Eklenti"],
    ["backups", "Yedekler"],
    ["startup", "Başlangıç"],
    ["network", "Ağ"],
    ["settings", "Ayarlar"],
  ];
  return tabs
    .map(([t, l]) => `<a href="#/server/${id}/${t}" class="${state.tab === t ? "active" : ""}">${l}</a>`)
    .join("");
}

function shell(inner, extra = "") {
  const u = state.me;
  return `
    <div class="shell ${extra}">
      <header class="topbar">
        <button type="button" class="menu-btn" id="menuBtn" aria-label="Menü"><span></span><span></span><span></span></button>
        <a class="brand" href="#/"><img src="${asset("assets/logo.png")}" alt="">HoptiNode</a>
      </header>
      <div class="nav-scrim" id="navScrim"></div>
      <aside class="sidebar">
        <a class="brand" href="#/" style="margin:4px 8px 16px"><img src="${asset("assets/logo.png")}" alt="">HoptiNode</a>
        <nav class="nav">${navItems()}</nav>
        <div class="side-foot">
          <div class="who">
            <div class="avatar">${esc((u.displayName || u.username).slice(0, 1).toUpperCase())}</div>
            <div>
              <strong>${esc(u.displayName || u.username)}</strong>
              <small class="role-${u.role}">${roleLabel(u.role)}</small>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" style="width:100%;margin-top:8px" id="logoutBtn">Çıkış</button>
        </div>
      </aside>
      ${inner}
    </div>`;
}

function renderLanding() {
  $("#app").innerHTML = `
    <div class="land">
      <header class="land-top">
        <a class="brand" href="#/"><img src="${asset("assets/logo.png")}" alt="">HoptiNode</a>
        <div>
          <a class="btn btn-ghost" href="#/login">Giriş</a>
          <a class="btn btn-primary" href="#/register">Kayıt ol</a>
        </div>
      </header>
      <section class="land-hero">
        <h1>Kontrol paneli.<br><span>HoptiNode.</span></h1>
        <p>Java, Paper, Fabric, Forge, Bedrock ve PocketMine sunucularını tek yerden oluştur, başlat, dosyalarını yönet.</p>
        <div class="land-cta">
          <a class="btn btn-primary" href="#/register">Hesap oluştur</a>
          <a class="btn btn-ghost" href="#/login">Panele gir</a>
        </div>
        <div id="tunnelBox" class="card" style="margin-top:22px;max-width:560px">
          <div class="hint">Dış tünel durumu yükleniyor…</div>
        </div>
      </section>
    </div>`;
  paintTunnels();
}

async function paintTunnels() {
  const box = $("#tunnelBox");
  if (!box) return;
  if (window.HN_STATIC) {
    box.innerHTML = `<div class="hint">HoptiNode çevrimiçi. Giriş: kurucu / Kurucu#2026</div>`;
    return;
  }
  box.innerHTML = "";
}

function renderAuth(mode) {
  const reg = mode === "register";
  $("#app").innerHTML = `
    <div class="auth-screen">
      <form class="auth-box" id="authForm">
        <div class="auth-brand"><img src="${asset("assets/logo.png")}" alt="">HoptiNode</div>
        <h1>${reg ? "Hesap oluştur" : "Panele giriş"}</h1>
        <p class="hint">${reg ? "Kullanıcı adı, e-posta ve parola yeterli." : "Kullanıcı adı veya e-posta ile gir."}</p>
        ${
          reg
            ? `<div class="field"><label>Görünen ad</label><input name="displayName" autocomplete="nickname"></div>`
            : ""
        }
        <div class="field"><label>Kullanıcı adı${reg ? "" : " veya e-posta"}</label>
          <input name="username" required autocomplete="username"></div>
        ${
          reg
            ? `<div class="field"><label>E-posta</label><input name="email" type="email" autocomplete="email"></div>`
            : ""
        }
        <div class="field"><label>Parola</label>
          <input name="password" type="password" required minlength="6" autocomplete="${reg ? "new-password" : "current-password"}"></div>
        ${
          reg
            ? `<div class="field"><label>Parola tekrar</label><input name="passwordConfirm" type="password" required minlength="6" autocomplete="new-password"></div>`
            : ""
        }
        <p class="err" id="authErr"></p>
        <button class="btn btn-primary auth-wide" type="submit">${reg ? "Kayıt ol" : "Giriş yap"}</button>
        <p class="auth-switch">${
          reg
            ? `Hesabın var mı? <a href="#/login">Giriş yap</a>`
            : `Hesabın yok mu? <a href="#/register">Kayıt ol</a>`
        }</p>
      </form>
    </div>`;
  $("#authForm").onsubmit = async (ev) => {
    ev.preventDefault();
    $("#authErr").textContent = "";
    const fd = new FormData(ev.target);
    const body = {
      username: String(fd.get("username") || "").trim(),
      password: fd.get("password"),
      email: fd.get("email") || "",
      displayName: fd.get("displayName") || "",
      passwordConfirm: fd.get("passwordConfirm") || fd.get("password"),
    };
    try {
      const data = await api(reg ? "/api/auth/register" : "/api/auth/login", { method: "POST", body });
      setToken(data.token);
      state.me = data.user;
      if (!state.meta) state.meta = { motd: "HoptiNode", me: data.user };
      else state.meta.me = data.user;
      if (location.hash === "#/" || location.hash === "#" || !location.hash) route();
      else location.hash = "#/";
    } catch (err) {
      $("#authErr").textContent = err.message;
    }
  };
}

function spark(samples, key) {
  const vals = (samples || []).map((s) => Number(s[key]) || 0);
  if (vals.length < 2) return `<svg class="spark" viewBox="0 0 100 40"></svg>`;
  const max = Math.max(1, ...vals);
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * 100;
      const y = 36 - (v / max) * 32;
      return `${x},${y}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none"><polyline fill="none" stroke="#3ee0c5" stroke-width="1.6" points="${pts}"/></svg>`;
}

async function renderDashboard() {
  const [srv, act, me] = await Promise.all([api("/api/servers"), api("/api/activity"), api("/api/me")]);
  state.servers = srv.servers;
  state.activity = act.activity;
  const online = state.servers.filter((s) => s.status === "running").length;
  const ram = state.servers.reduce((a, s) => a + (s.memoryMb || 0), 0);
  $("#app").innerHTML = shell(`
    <section class="main">
      <div class="page-head">
        <div>
          <h1>Gösterge paneli</h1>
          <p>${esc(state.meta?.motd || "HoptiNode")}</p>
        </div>
        <a class="btn btn-primary" href="#/create">Sunucu oluştur</a>
      </div>
      <div class="stats">
        <div class="stat"><div class="lbl">Sunucular</div><div class="val">${state.servers.length}</div><div class="sub">${online} çevrimiçi</div></div>
        <div class="stat"><div class="lbl">Ayrılan bellek</div><div class="val">${ram}<span style="font-size:13px;color:var(--muted)"> MB</span></div><div class="sub">kota ${state.me.unlimited ? "sınırsız" : (state.me.ramQuotaMb || 0) + " MB"}</div></div>
        <div class="stat"><div class="lbl">Düğüm RAM</div><div class="val">${me.host.ramTotalMb}</div><div class="sub">${me.host.cores} çekirdek · ${esc(me.host.hostname)}</div></div>
        <div class="stat"><div class="lbl">Rol</div><div class="val" style="font-size:18px;padding-top:6px">${roleLabel(state.me.role)}</div><div class="sub">${esc(state.me.username)}</div></div>
      </div>
      <div class="grid-2">
        <div>
          <h3 style="margin:0 0 10px;font-size:14px">Sunucuların</h3>
          ${serverTable(state.servers)}
        </div>
        <div>
          <h3 style="margin:0 0 10px;font-size:14px">Son işlemler</h3>
          <div class="card" style="padding:0">
            ${(state.activity || [])
              .slice(0, 8)
              .map(
                (a) =>
                  `<div style="padding:10px 12px;border-bottom:1px solid var(--line);font-size:12px">
                    <div>${esc(a.action)} · ${esc(a.detail || "")}</div>
                    <div class="hint">${esc(a.actor)} · ${new Date(a.at).toLocaleString("tr-TR")}</div>
                  </div>`
              )
              .join("") || `<div class="hint" style="padding:14px">Henüz kayıt yok.</div>`}
          </div>
        </div>
      </div>
    </section>`);
  bindShell();
  bindServerRows();
}

function serverTable(list) {
  if (!list.length) {
    return `<div class="card hint">Sunucu yok. <a href="#/create">Bir tane oluştur.</a></div>`;
  }
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th>Ad</th><th>Yumurta</th><th>Kaynak</th><th>Adres</th><th>Durum</th><th></th></tr></thead>
    <tbody>
      ${list
        .map((s) => {
          const cpu = s.stats?.cpu || 0;
          const mem = s.stats?.memoryMb || 0;
          return `<tr class="click" data-open="${s.id}">
            <td><strong>${esc(s.name)}</strong><div class="hint">${esc(s.owner?.username || "")}</div></td>
            <td>${esc(s.egg?.name || s.eggId)}</td>
            <td style="min-width:140px">
              <div class="hint">${mem}/${s.memoryMb} MB · CPU ${cpu}%</div>
              <div class="bar"><i style="width:${Math.min(100, (mem / Math.max(1, s.memoryMb)) * 100)}%"></i></div>
            </td>
            <td class="hint">${esc(s.address || "playit-bekleniyor")}</td>
            <td><span class="badge st-${esc(s.status)}">${statusLabel(s.status)}</span></td>
            <td>
              ${
                s.status === "running"
                  ? `<button class="btn btn-warn btn-sm" data-pwr="${s.id}" data-act="stop">Durdur</button>`
                  : `<button class="btn btn-ok btn-sm" data-pwr="${s.id}" data-act="start">Başlat</button>`
              }
            </td>
          </tr>`;
        })
        .join("")}
    </tbody></table></div>`;
}

function bindServerRows() {
  document.querySelectorAll("[data-open]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-pwr]")) return;
      location.hash = "#/server/" + tr.dataset.open + "/console";
    });
  });
  document.querySelectorAll("[data-pwr]").forEach((b) => {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/servers/${b.dataset.pwr}/power`, { method: "POST", body: { action: b.dataset.act } });
        toast(b.dataset.act === "start" ? "Başlatıldı" : "Durduruluyor");
        setTimeout(route, 500);
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

async function renderServers() {
  state.servers = (await api("/api/servers")).servers;
  const q = state.q || "";
  const filtered = state.servers.filter((s) =>
    (s.name + s.eggId + (s.egg?.name || "")).toLowerCase().includes(q.toLowerCase())
  );
  $("#app").innerHTML = shell(`
    <section class="main">
      <div class="page-head">
        <div><h1>Sunucular</h1><p>${state.servers.length} kayıt</p></div>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="search" id="q" placeholder="Ara…" value="${esc(q)}">
          <a class="btn btn-primary" href="#/create">Oluştur</a>
        </div>
      </div>
      ${serverTable(filtered)}
    </section>`);
  bindShell();
  bindServerRows();
  $("#q").oninput = () => {
    state.q = $("#q").value;
    renderServers();
  };
}

async function renderCreate() {
  if (!state.eggs.length) state.eggs = (await api("/api/eggs")).eggs;
  if (!state.pickedEgg) state.pickedEgg = "paper";
  const egg = state.eggs.find((e) => e.id === state.pickedEgg) || state.eggs[0];
  state.pickedEgg = egg.id;
  const prevName = (state.createDraft && state.createDraft.name) || "";
  $("#app").innerHTML = shell(`
    <section class="main">
      <div class="page-head"><div><h1>Sunucu oluştur</h1><p>Yumurtayı seç, ad ver, oluştur.</p></div></div>
      <form id="createForm">
        <h3 style="font-size:14px;margin:0 0 10px">Yumurta</h3>
        <div class="eggs">${state.eggs
          .map(
            (e) => `<button type="button" class="egg ${state.pickedEgg === e.id ? "picked" : ""}" data-egg="${e.id}">
              <div class="cat">${esc(e.category)}</div><h3>${esc(e.name)}</h3><p>${esc(e.short)}</p></button>`
          )
          .join("")}</div>
        <div class="card form-grid" style="margin-top:16px">
          <div class="field"><label>Sunucu adı</label><input name="name" minlength="2" maxlength="32" placeholder="survival-01" value="${esc(prevName)}"></div>
          <div class="field"><label>Açıklama</label><input name="description" maxlength="200"></div>
          <div class="field"><label>RAM (MB)</label><input name="memoryMb" type="number" min="256" step="128" value="1024"></div>
          <div class="field"><label>CPU (%)</label><input name="cpuPercent" type="number" min="25" step="25" value="100"></div>
          <div class="field"><label>MOTD</label><input name="motd" value="HoptiNode ${esc(egg.name)}"></div>
          <div class="field"><label>Oyun sürümü</label>
            ${
              (egg.gameVersions || []).length
                ? `<select name="gameVersion">${(egg.gameVersions || [])
                    .map((v) => {
                      const def = (egg.variables || []).find((x) => x.key === "MC_VERSION" || x.key === "BDX_VERSION");
                      const sel = v === ((def && def.default) || (egg.protocol === "bedrock" ? "0.14.3" : "1.21.4"));
                      return `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(v)}</option>`;
                    })
                    .join("")}<option value="custom">özel…</option></select>
                   <input name="gameVersionCustom" placeholder="ör. 1.16.5 veya 0.14.3" style="margin-top:6px">`
                : `<input name="gameVersion" placeholder="${egg.protocol === "bedrock" ? "0.14.3" : "1.21.4"}">`
            }
          </div>
          <div class="field"><label>Port</label><input name="port" type="number" min="1" max="65535" placeholder="${egg.protocol === "bedrock" ? "19132" : "25565"}"></div>
        </div>
        <p class="hint">Java sürümü ilk başlatmada indirilir. Konsolda “JAR indiriliyor” ve “Done” görünene kadar bekle, sonra oyundan gir.</p>
        <p class="err" id="createErr"></p>
        <button class="btn btn-primary" type="submit" style="margin-top:12px">Oluştur ve başlat</button>
      </form>
    </section>`);
  bindShell();
  document.querySelectorAll("[data-egg]").forEach((b) => {
    b.onclick = () => {
      const form = $("#createForm");
      if (form) state.createDraft = Object.fromEntries(new FormData(form).entries());
      state.pickedEgg = b.dataset.egg;
      renderCreate();
    };
  });
  $("#createForm").onsubmit = submitCreate;
}

function eggProtocolEnv(eggId, ver) {
  if (["pocketmine", "nukkit", "bedrock"].includes(eggId)) return { BDX_VERSION: ver };
  return { MC_VERSION: ver };
}

async function submitCreate(ev) {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const name = String(fd.get("name") || "").trim() || "sunucu-" + Date.now().toString(36).slice(-5);
  $("#createErr").textContent = "";
  try {
    const data = await api("/api/servers", {
      method: "POST",
      body: {
        name,
        description: fd.get("description") || "",
        eggId: state.pickedEgg || "paper",
        memoryMb: Number(fd.get("memoryMb") || 1024),
        cpuPercent: Number(fd.get("cpuPercent") || 100),
        diskMb: 8192,
        motd: fd.get("motd") || name,
        autoStart: true,
        port: fd.get("port") ? Number(fd.get("port")) : undefined,
        env: (() => {
          const v = String(fd.get("gameVersionCustom") || "").trim() || String(fd.get("gameVersion") || "").trim();
          if (!v || v === "custom") return {};
          return eggProtocolEnv(state.pickedEgg, v);
        })(),
      },
    });
    state.createDraft = null;
    toast("Açıldı: " + (data.server.address || data.server.name));
    location.hash = "#/server/" + data.server.id + "/console";
  } catch (err) {
    $("#createErr").textContent = err.message;
    toast(err.message);
  }
}

function connectConsole(id) {
  closeWs();
  if (window.HN_STATIC) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ server: id });
  if (token()) q.set("token", token());
  const ws = new WebSocket(`${proto}://${location.host}/ws/console?${q}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    const entry = JSON.parse(ev.data);
    const box = $("#consoleBox");
    if (!box) return;
    const line = document.createElement("div");
    line.className = "l-" + (entry.stream || "stdout");
    line.textContent = entry.line;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  };
}

async function renderServer(id, tab) {
  state.tab = tab || "console";
  const data = await api("/api/servers/" + id);
  const s = data.server;
  const egg = data.egg || {};
  const st = s.stats || {};
  $("#app").innerHTML = shell(
    `
    <aside class="subnav">
      <h4>${esc(s.name)}</h4>
      <nav class="nav">${subNav(id)}</nav>
    </aside>
    <section class="main">
      <div class="page-head">
        <div>
          <h1>${esc(s.name)}</h1>
          <p>${esc(egg.name || s.eggId)} · ${s.memoryMb} MB · ${esc(s.address || (":" + s.port))} · ${esc((s.uuid || "").slice(0, 8))}</p>
        </div>
        <div class="power">
          <span class="badge st-${esc(s.status)}">${statusLabel(s.status)}</span>
          <button class="btn btn-ok btn-sm" data-power="start">Başlat</button>
          <button class="btn btn-warn btn-sm" data-power="restart">Yeniden</button>
          <button class="btn btn-ghost btn-sm" data-power="stop">Durdur</button>
          <button class="btn btn-danger btn-sm" data-power="kill">Öldür</button>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="lbl">CPU</div><div class="val">${st.cpu || 0}%</div>${spark(st.samples, "cpu")}</div>
        <div class="stat"><div class="lbl">Bellek</div><div class="val">${st.memoryMb || 0}<span style="font-size:13px;color:var(--muted)"> / ${s.memoryMb}</span></div>${spark(st.samples, "mem")}</div>
        <div class="stat"><div class="lbl">Disk</div><div class="val" style="font-size:18px">${fmtBytes(st.diskBytes || 0)}</div><div class="sub">limit ${s.diskMb} MB</div></div>
        <div class="stat"><div class="lbl">Uptime</div><div class="val" style="font-size:18px">${s.status === "running" ? fmtUp(st.uptime) : "—"}</div><div class="sub">${esc(st.engine || "kapalı")}</div></div>
      </div>
      <div id="tabBody"></div>
    </section>`,
    "with-sub"
  );
  bindShell();
  document.querySelectorAll("[data-power]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/servers/${s.id}/power`, { method: "POST", body: { action: b.dataset.power } });
        toast("Komut gönderildi");
        setTimeout(() => renderServer(s.id, state.tab), 400);
      } catch (err) {
        toast(err.message);
      }
    };
  });

  const body = $("#tabBody");
  if (state.tab === "console") {
    body.innerHTML = `
      <div class="console-wrap">
        <div class="console" id="consoleBox">${(data.logs || [])
          .map((l) => `<div class="l-${esc(l.stream)}">${esc(l.line)}</div>`)
          .join("")}</div>
        <form class="console-in" id="cmdForm">
          <input id="cmdInput" autocomplete="off" placeholder="komut…  help, say, list, stop">
          <button class="btn btn-primary btn-sm" type="submit">Gönder</button>
        </form>
      </div>`;
    const box = $("#consoleBox");
    box.scrollTop = box.scrollHeight;
    connectConsole(s.id);
    $("#cmdForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const cmd = $("#cmdInput").value;
      if (!cmd.trim()) return;
      $("#cmdInput").value = "";
      try {
        await api(`/api/servers/${s.id}/console`, { method: "POST", body: { command: cmd } });
        if (window.HN_STATIC) renderServer(s.id, "console");
      } catch (err) {
        toast(err.message);
      }
    };
    stopPoll();
    state.poll = setInterval(async () => {
      try {
        const stt = await api(`/api/servers/${s.id}/stats`);
        if (stt.status !== s.status) renderServer(s.id, "console");
      } catch {
        /* */
      }
    }, 5000);
  } else if (state.tab === "files") {
    closeWs();
    await renderFiles(s.id);
  } else if (state.tab === "content") {
    closeWs();
    await renderContent(s);
  } else if (state.tab === "backups") {
    closeWs();
    const bks = data.backups || [];
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:10px">
        <p class="hint" style="margin:0">Sunucu klasörünün tar.gz kopyası.</p>
        <div style="display:flex;gap:8px">
          <label class="btn btn-ghost btn-sm">Yedek yükle<input type="file" id="upBk" accept=".zip,.tar.gz,.tgz,.tar" hidden></label>
          <button class="btn btn-primary btn-sm" id="mkBk">Yedek al</button>
        </div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Dosya</th><th>Boyut</th><th>Tarih</th><th></th></tr></thead>
        <tbody>
          ${
            bks
              .map(
                (b) => `<tr>
                  <td>${esc(b.name || b.file)}</td><td>${fmtBytes(b.size)}</td>
                  <td>${new Date(b.createdAt).toLocaleString("tr-TR")}</td>
                  <td>
                    <button class="btn btn-primary btn-sm" data-dlb="${b.id}">İndir</button>
                    <button class="btn btn-ghost btn-sm" data-res="${b.id}">Geri yükle</button>
                    <button class="btn btn-danger btn-sm" data-delb="${b.id}">Sil</button>
                  </td>
                </tr>`
              )
              .join("") || `<tr><td colspan="4" class="hint">Yedek yok</td></tr>`
          }
        </tbody></table></div>`;
    if ($("#upBk"))
      $("#upBk").onchange = async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("path", "backups");
          const headers = {};
          if (token()) headers.Authorization = "Bearer " + token();
          const res = await fetch(`/api/servers/${s.id}/files/upload`, { method: "POST", body: fd, headers, credentials: "same-origin" });
          const js = await res.json();
          if (!res.ok) throw new Error(js.error || "Yükleme hatası");
          toast(js.unpacked ? "Yedek yüklendi ve açıldı" : "Yedek yüklendi");
          renderServer(s.id, "backups");
        } catch (err) {
          toast(err.message);
        }
      };
    $("#mkBk").onclick = async () => {
      try {
        await api(`/api/servers/${s.id}/backups`, { method: "POST", body: {} });
        toast("Yedek alındı");
        renderServer(s.id, "backups");
      } catch (err) {
        toast(err.message);
      }
    };
    document.querySelectorAll("[data-res]").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Yedek geri yüklensin mi? Sunucu kapalı olmalı.")) return;
        try {
          await api(`/api/servers/${s.id}/backups/${b.dataset.res}/restore`, { method: "POST", body: {} });
          toast("Geri yüklendi");
        } catch (err) {
          toast(err.message);
        }
      };
    });
    document.querySelectorAll("[data-dlb]").forEach((b) => {
      b.onclick = async () => {
        try {
          const res = await fetch(`/api/servers/${s.id}/backups/${b.dataset.dlb}/download`, {
            headers: token() ? { Authorization: "Bearer " + token() } : {},
            credentials: "same-origin",
          });
          if (!res.ok) throw new Error("İndirilemedi");
          const blob = await res.blob();
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = (s.name || "sunucu") + "-" + b.dataset.dlb + ".tar.gz";
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
          toast("Yedek indirildi");
        } catch (err) {
          toast(err.message);
        }
      };
    });
    document.querySelectorAll("[data-delb]").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/servers/${s.id}/backups/${b.dataset.delb}`, { method: "DELETE" });
        renderServer(s.id, "backups");
      };
    });
  } else if (state.tab === "startup") {
    closeWs();
    body.innerHTML = `
      <div class="card">
        <div class="field"><label>Başlangıç komutu</label><input readonly value="${esc(egg.startup || "HoptiNode dahili motor")}"></div>
        <div class="field"><label>Görüntü</label><input readonly value="${esc(egg.dockerImage || "yerel / dahili")}"></div>
        ${(egg.variables || [])
          .map(
            (v) =>
              `<div class="field"><label>${esc(v.name)}</label><input data-env="${esc(v.key)}" value="${esc(
                (s.env && s.env[v.key]) || v.default || ""
              )}"></div>`
          )
          .join("")}
        <button class="btn btn-primary" id="saveEnv">Kaydet</button>
      </div>`;
    $("#saveEnv").onclick = async () => {
      const env = {};
      document.querySelectorAll("[data-env]").forEach((i) => (env[i.dataset.env] = i.value));
      await api("/api/servers/" + s.id, { method: "PATCH", body: { env } });
      toast("Kaydedildi");
    };
  } else if (state.tab === "network") {
    closeWs();
    body.innerHTML = `
      <div class="card">
        <div class="field"><label>Giriş adresi</label>
          <div style="display:flex;gap:8px">
            <input id="ipBox" readonly value="${esc(s.address || "playit-bekleniyor")}">
            <button type="button" class="btn btn-primary btn-sm" id="copyIp">Kopyala</button>
          </div>
        </div>
        <p class="hint">${
          egg.protocol === "bedrock"
            ? "Bedrock / Nukkit / PocketMine bu adresi kullanır. Playit tünelde Proxy Protocol KAPALI olsun."
            : "Java / Paper / Fabric / Forge bu adresi kullanır. Ücretsiz planda tüm Java sunucuları aynı adresi paylaşır."
        }</p>
        <div class="field"><label>Protokol</label><input readonly value="${esc(egg.protocol || "java")}"></div>
      </div>`;
    const cip = $("#copyIp");
    if (cip)
      cip.onclick = async () => {
        try {
          await navigator.clipboard.writeText($("#ipBox").value);
          toast("IP kopyalandı");
        } catch {
          toast($("#ipBox").value);
        }
      };
  } else {
    closeWs();
    body.innerHTML = `
      <form class="card" id="srvForm">
        <div class="form-grid">
          <div class="field"><label>Ad</label><input name="name" value="${esc(s.name)}" required></div>
          <div class="field"><label>Açıklama</label><input name="description" value="${esc(s.description || "")}"></div>
          <div class="field"><label>RAM MB</label><input name="memoryMb" type="number" value="${s.memoryMb}"></div>
          <div class="field"><label>CPU %</label><input name="cpuPercent" type="number" value="${s.cpuPercent}"></div>
          <div class="field"><label>Disk MB</label><input name="diskMb" type="number" value="${s.diskMb}"></div>
          <div class="field"><label>Port</label><input name="port" type="number" value="${s.port}"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-primary" type="submit">Kaydet</button>
          <button class="btn btn-danger" type="button" id="delSrv">Sunucuyu sil</button>
        </div>
      </form>`;
    $("#srvForm").onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      await api("/api/servers/" + s.id, {
        method: "PATCH",
        body: {
          name: fd.get("name"),
          description: fd.get("description"),
          memoryMb: Number(fd.get("memoryMb")),
          cpuPercent: Number(fd.get("cpuPercent")),
          diskMb: Number(fd.get("diskMb")),
          port: Number(fd.get("port")),
        },
      });
      toast("Güncellendi");
      renderServer(s.id, "settings");
    };
    $("#delSrv").onclick = async () => {
      if (!confirm("Sunucu silinsin mi?")) return;
      await api("/api/servers/" + s.id, { method: "DELETE" });
      location.hash = "#/servers";
    };
  }
}

async function downloadArchive(id, paths, filename) {
  const res = await fetch(`/api/servers/${id}/files/archive`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(token() ? { Authorization: "Bearer " + token() } : {}) },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    const js = await res.json().catch(() => ({}));
    throw new Error(js.error || "Arşiv hatası");
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename || "arsiv.tar.gz";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function renderContent(s) {
  const installed = await api(`/api/servers/${s.id}/content`);
  const isBedrock = s.egg && s.egg.protocol === "bedrock";
  $("#tabBody").innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <p class="hint" style="margin:0 0 10px">${
        isBedrock
          ? "Poggit gönüllü eklentileri. Kendi .phar dosyanı Dosyalar sekmesinden de yükleyebilirsin (PocketMine-MP.phar)."
          : "Modrinth sunucu modları / eklentileri. İndir, sil, tekrar kur = güncelle."
      }</p>
      <form id="modSearch" style="display:flex;gap:8px;flex-wrap:wrap">
        <input id="modQ" placeholder="${isBedrock ? "eklenti ara…" : "mod ara…"}" style="flex:1;min-width:180px">
        <button class="btn btn-primary btn-sm" type="submit">Ara</button>
      </form>
      <div id="modHits" style="margin-top:12px"></div>
    </div>
    <h3 style="font-size:14px;margin:0 0 8px">Yüklü (${esc(installed.folder || "")})</h3>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>Dosya</th><th>Boyut</th><th></th></tr></thead>
      <tbody>
        ${(installed.items || [])
          .map(
            (it) => `<tr>
              <td>${esc(it.name)}</td><td>${fmtBytes(it.size)}</td>
              <td><button class="btn btn-danger btn-sm" data-rm="${esc(it.name)}">Sil</button></td>
            </tr>`
          )
          .join("") || `<tr><td colspan="3" class="hint">Boş</td></tr>`}
      </tbody></table></div>`;
  $("#modSearch").onsubmit = async (ev) => {
    ev.preventDefault();
    const box = $("#modHits");
    box.innerHTML = `<div class="hint">Aranıyor…</div>`;
    try {
      const data = await api(`/api/servers/${s.id}/content/search`, { method: "POST", body: { query: $("#modQ").value } });
      const hits = data.hits || [];
      box.innerHTML = hits.length
        ? hits
            .map(
              (h) => `<div style="padding:8px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:center">
                <div><strong>${esc(h.name)}</strong> <span class="hint">${esc(h.version || "")} · ${esc(h.author || "")} · ${h.downloads || 0}</span>
                <div class="hint">${esc(h.description || "")}</div></div>
                <button class="btn btn-ok btn-sm" data-src="${esc(h.source)}" data-id="${esc(h.id)}">Kur</button>
              </div>`
            )
            .join("")
        : `<div class="hint">Sonuç yok</div>`;
      box.querySelectorAll("[data-src]").forEach((b) => {
        b.onclick = async () => {
          try {
            await api(`/api/servers/${s.id}/content/install`, { method: "POST", body: { source: b.dataset.src, id: b.dataset.id } });
            toast("Kuruldu");
            renderContent(s);
          } catch (err) {
            toast(err.message);
          }
        };
      });
    } catch (err) {
      box.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    }
  };
  document.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Silinsin mi?")) return;
      await api(`/api/servers/${s.id}/content?name=${encodeURIComponent(b.dataset.rm)}`, { method: "DELETE" });
      renderContent(s);
    };
  });
}

async function renderFiles(id) {
  const pth = state.filePath || ".";
  const data = await api(`/api/servers/${id}/files?path=${encodeURIComponent(pth)}`);
  const parent = pth === "." ? null : pth.split("/").slice(0, -1).join("/") || ".";
  $("#tabBody").innerHTML = `
    <div class="crumb">/${esc(pth === "." ? "" : pth)}</div>
    <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
      ${parent ? `<button class="btn btn-ghost btn-sm" id="upDir">Üst</button>` : ""}
      <button class="btn btn-ghost btn-sm" id="mkDir">Klasör</button>
      <label class="btn btn-ghost btn-sm">Yükle (zip/tar.gz/phar)<input type="file" id="upFile" accept=".zip,.tar,.gz,.tgz,.phar,.jar,*" hidden></label>
      <button class="btn btn-ghost btn-sm" id="selAll">Tümünü seç</button>
      <button class="btn btn-primary btn-sm" id="dlSel">Seçileni arşivle</button>
    </div>
    <div class="files"><table>
      <thead><tr><th></th><th>Ad</th><th>Boyut</th><th>Tarih</th><th></th></tr></thead>
      <tbody>
        ${data.entries
          .map(
            (e) => `<tr>
              <td><input type="checkbox" class="fchk" value="${esc(pth === "." ? e.name : pth + "/" + e.name)}"></td>
              <td>${
                e.type === "dir"
                  ? `<button class="linkish" data-dir="${esc(e.name)}">${esc(e.name)}/</button>`
                  : `<button class="linkish" data-file="${esc(e.name)}">${esc(e.name)}</button>`
              }</td>
              <td>${e.type === "dir" ? "—" : fmtBytes(e.size)}</td>
              <td>${new Date(e.mtime).toLocaleString("tr-TR")}</td>
              <td>${
                /\.(zip|tgz|gz|tar)$/i.test(e.name)
                  ? `<button class="linkish" data-unpack="${esc(e.name)}">aç</button> `
                  : ""
              }<button class="linkish" data-del="${esc(e.name)}" style="color:var(--rose)">sil</button></td>
            </tr>`
          )
          .join("")}
      </tbody></table></div>
    <div id="editBox"></div>`;
  if ($("#upDir"))
    $("#upDir").onclick = () => {
      state.filePath = parent;
      renderFiles(id);
    };
  document.querySelectorAll("[data-dir]").forEach((b) => {
    b.onclick = () => {
      state.filePath = pth === "." ? b.dataset.dir : pth + "/" + b.dataset.dir;
      renderFiles(id);
    };
  });
  document.querySelectorAll("[data-file]").forEach((b) => {
    b.onclick = () => openFile(id, pth === "." ? b.dataset.file : pth + "/" + b.dataset.file);
  });
  document.querySelectorAll("[data-unpack]").forEach((b) => {
    b.onclick = async () => {
      const rel = pth === "." ? b.dataset.unpack : pth + "/" + b.dataset.unpack;
      try {
        await api(`/api/servers/${id}/files/extract`, { method: "POST", body: { path: rel } });
        toast("Açıldı: " + b.dataset.unpack);
        renderFiles(id);
      } catch (err) {
        toast(err.message);
      }
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Silinsin mi?")) return;
      const p = pth === "." ? b.dataset.del : pth + "/" + b.dataset.del;
      await api(`/api/servers/${id}/files?path=${encodeURIComponent(p)}`, { method: "DELETE" });
      renderFiles(id);
    };
  });
  $("#mkDir").onclick = async () => {
    const name = prompt("Klasör adı");
    if (!name) return;
    await api(`/api/servers/${id}/files/mkdir`, { method: "POST", body: { path: pth === "." ? name : pth + "/" + name } });
    renderFiles(id);
  };
  $("#upFile").onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const dest = pth === "." ? file.name : pth + "/" + file.name;
    let js = {};
    try {
      if (window.HN_STATIC) {
        const text = await file.text();
        await api(`/api/servers/${id}/files/upload`, { method: "POST", body: { path: dest, content: text } });
      } else {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("path", pth);
        const headers = {};
        if (token()) headers.Authorization = "Bearer " + token();
        const res = await fetch(`/api/servers/${id}/files/upload`, { method: "POST", body: fd, headers, credentials: "same-origin" });
        js = await res.json();
        if (!res.ok) throw new Error(js.error || "Yükleme hatası");
      }
      toast(js && js.unpacked ? "Yüklendi ve açıldı: " + file.name : "Yüklendi: " + file.name);
      renderFiles(id);
    } catch (err) {
      toast(err.message || "Yükleme hatası");
    }
  };
  const selAll = $("#selAll");
  if (selAll)
    selAll.onclick = () => {
      const boxes = [...document.querySelectorAll(".fchk")];
      const on = boxes.some((c) => !c.checked);
      boxes.forEach((c) => (c.checked = on));
    };
  const dlSel = $("#dlSel");
  if (dlSel)
    dlSel.onclick = async () => {
      const paths = [...document.querySelectorAll(".fchk:checked")].map((c) => c.value);
      if (!paths.length) return toast("Dosya seç");
      try {
        await downloadArchive(id, paths, "secilen-arsiv.tar.gz");
        toast("Arşiv indirildi");
      } catch (err) {
        toast(err.message);
      }
    };
}

async function openFile(id, pth) {
  try {
    const data = await api(`/api/servers/${id}/files/content?path=${encodeURIComponent(pth)}`);
    $("#editBox").innerHTML = `
      <h3 style="margin:16px 0 8px;font-size:14px">${esc(pth)}</h3>
      <textarea class="editor" id="fileEd">${esc(data.content)}</textarea>
      <button class="btn btn-primary" style="margin-top:10px" id="saveFile">Kaydet</button>`;
    $("#saveFile").onclick = async () => {
      await api(`/api/servers/${id}/files/content`, { method: "PUT", body: { path: pth, content: $("#fileEd").value } });
      toast("Kaydedildi");
    };
  } catch (err) {
    toast(err.message);
  }
}

function renderAccount() {
  const u = state.me;
  $("#app").innerHTML = shell(`
    <section class="main">
      <div class="page-head"><div><h1>Hesap</h1><p>Profil ve parola</p></div></div>
      <form class="card" id="accForm" style="max-width:480px">
        <div class="field"><label>Kullanıcı adı</label><input value="${esc(u.username)}" disabled></div>
        <div class="field"><label>Görünen ad</label><input name="displayName" value="${esc(u.displayName || "")}"></div>
        <div class="field"><label>E-posta</label><input name="email" type="email" value="${esc(u.email || "")}"></div>
        <div class="field"><label>Yeni parola</label><input name="password" type="password" minlength="6"></div>
        <button class="btn btn-primary" type="submit">Kaydet</button>
      </form>
    </section>`);
  bindShell();
  $("#accForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = { displayName: fd.get("displayName"), email: fd.get("email") };
    if (fd.get("password")) body.password = fd.get("password");
    const data = await api("/api/me", { method: "PATCH", body });
    state.me = data.user;
    toast("Kaydedildi");
    renderAccount();
  };
}

async function renderAdmin() {
  const data = await api("/api/admin/overview");
  const h = data.host;
  $("#app").innerHTML = shell(`
    <section class="main">
      <div class="page-head"><div><h1>Yönetim</h1><p>${esc(h.hostname)} · ${h.cores} CPU · ${h.ramTotalMb} MB</p></div></div>
      <div class="stats">
        <div class="stat"><div class="lbl">Üye</div><div class="val">${data.counts.users}</div></div>
        <div class="stat"><div class="lbl">Sunucu</div><div class="val">${data.counts.servers}</div></div>
        <div class="stat"><div class="lbl">Çevrimiçi</div><div class="val">${data.counts.online}</div></div>
        <div class="stat"><div class="lbl">Boş RAM</div><div class="val">${h.ramFreeMb}</div></div>
      </div>
      <h3 style="font-size:14px">Kullanıcılar</h3>
      <div class="table-wrap" style="margin-bottom:18px"><table class="data">
        <thead><tr><th>Kullanıcı</th><th>Rol</th><th>Kota</th><th></th></tr></thead>
        <tbody>
          ${data.users
            .map(
              (u) => `<tr>
                <td>${esc(u.username)} <span class="hint">${esc(u.displayName || "")}</span></td>
                <td>${roleLabel(u.role)}</td>
                <td>${u.unlimited ? "sınırsız" : u.ramQuotaMb + " MB"}</td>
                <td>${
                  u.role === "founder"
                    ? ""
                    : `<button class="btn btn-ghost btn-sm" data-promo="${u.id}" data-role="${
                        u.role === "admin" ? "user" : "admin"
                      }">${u.role === "admin" ? "üye yap" : "yönetici"}</button>
                       <button class="btn btn-ghost btn-sm" data-unlim="${u.id}" data-v="${u.unlimited ? "0" : "1"}">kota</button>
                       <button class="btn btn-danger btn-sm" data-ban="${u.id}" data-v="${u.banned ? "0" : "1"}">${
                        u.banned ? "aç" : "askı"
                      }</button>`
                }</td>
              </tr>`
            )
            .join("")}
        </tbody></table></div>
      ${
        state.me.role === "founder"
          ? `<div class="grid-2">
              <form class="card" id="newUser">
                <h3 style="margin:0 0 10px;font-size:14px">Yeni hesap</h3>
                <div class="field"><label>Kullanıcı</label><input name="username" required></div>
                <div class="field"><label>Parola</label><input name="password" required minlength="6"></div>
                <div class="field"><label>Rol</label><select name="role"><option value="user">üye</option><option value="admin">yönetici</option></select></div>
                <div class="field"><label>Sınırsız</label><select name="unlimited"><option value="false">hayır</option><option value="true">evet</option></select></div>
                <button class="btn btn-primary" type="submit">Oluştur</button>
              </form>
              <form class="card" id="setForm">
                <h3 style="margin:0 0 10px;font-size:14px">Panel</h3>
                <div class="field"><label>Karşılama</label><input name="motd" value="${esc(data.settings.motd || "")}"></div>
                <div class="field"><label>Kayıt</label>
                  <select name="registrationOpen">
                    <option value="true" ${data.settings.registrationOpen !== false ? "selected" : ""}>açık</option>
                    <option value="false" ${data.settings.registrationOpen === false ? "selected" : ""}>kapalı</option>
                  </select>
                </div>
                <div class="field"><label>Playit hesap API anahtarı</label>
                  <input name="playitApiKey" placeholder="${data.settings.playitApiKey ? "kayıtlı — değiştirmek için yaz" : "Account API key (Agent secret değil)"}">
                </div>
                <button class="btn btn-primary" type="submit">Kaydet</button>
              </form>
            </div>`
          : `<p class="hint">Yönetici atamak yalnızca kurucuda.</p>`
      }
    </section>`);
  bindShell();
  document.querySelectorAll("[data-promo]").forEach((b) => {
    b.onclick = async () => {
      try {
        await api("/api/admin/users/" + b.dataset.promo, { method: "PATCH", body: { role: b.dataset.role } });
        renderAdmin();
      } catch (err) {
        toast(err.message);
      }
    };
  });
  document.querySelectorAll("[data-unlim]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/admin/users/" + b.dataset.unlim, { method: "PATCH", body: { unlimited: b.dataset.v === "1" } });
      renderAdmin();
    };
  });
  document.querySelectorAll("[data-ban]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/admin/users/" + b.dataset.ban, { method: "PATCH", body: { banned: b.dataset.v === "1" } });
      renderAdmin();
    };
  });
  const nu = $("#newUser");
  if (nu)
    nu.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(nu);
      try {
        await api("/api/admin/users", {
          method: "POST",
          body: {
            username: fd.get("username"),
            password: fd.get("password"),
            role: fd.get("role"),
            unlimited: fd.get("unlimited") === "true",
          },
        });
        toast("Eklendi");
        renderAdmin();
      } catch (err) {
        toast(err.message);
      }
    };
  const sf = $("#setForm");
  if (sf)
    sf.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(sf);
      await api("/api/admin/settings", {
        method: "PATCH",
        body: { motd: fd.get("motd"), registrationOpen: fd.get("registrationOpen") === "true", playitApiKey: fd.get("playitApiKey") || undefined },
      });
      toast("Ayarlar kaydedildi");
    };
}

function bindShell() {
  const out = $("#logoutBtn");
  if (out)
    out.onclick = async () => {
      try {
        await api("/api/auth/logout", { method: "POST", body: {} });
      } catch {
        /* */
      }
      setToken("");
      state.me = null;
      location.hash = "#/login";
      route();
    };
}

async function route() {
  stopPoll();
  const h = hash();
  const logged = !!state.me;
  try {
    if (!logged) {
      closeWs();
      if (h.startsWith("#/register")) return renderAuth("register");
      if (h.startsWith("#/login")) return renderAuth("login");
      return renderLanding();
    }
    if (h.startsWith("#/login") || h.startsWith("#/register")) {
      location.hash = "#/";
      return;
    }
    if (h.startsWith("#/server/")) {
      const parts = h.split("/");
      await renderServer(parts[2], parts[3] || "console");
      return;
    }
    closeWs();
    state.filePath = ".";
    if (h.startsWith("#/servers")) return renderServers();
    if (h.startsWith("#/create")) return renderCreate();
    if (h.startsWith("#/account")) return renderAccount();
    if (h.startsWith("#/admin")) {
      if (!staff()) {
        location.hash = "#/";
        return;
      }
      return renderAdmin();
    }
    return renderDashboard();
  } catch (err) {
    $("#app").innerHTML = `<div class="auth-screen"><div class="auth-box"><p class="err">${esc(err.message)}</p><a href="#/login">Giriş</a></div></div>`;
  }
}


async function boot() {
  if (location.hostname.indexOf("github.io") !== -1) window.HN_STATIC = true;
  if (!window.HN_STATIC) {
    try {
      const h = await fetch("/api/health", { cache: "no-store" });
      if (!h.ok) window.HN_STATIC = true;
    } catch {
      window.HN_STATIC = true;
    }
  }
  try {
    state.meta = await api("/api/meta");
    state.me = state.meta.me || null;
    if (!state.me && token()) {
      try {
        const me = await api("/api/me");
        state.me = me.user;
      } catch {
        setToken("");
        state.me = null;
      }
    }
  } catch (e) {
    console.error(e);
    state.me = null;
  }
  route();
}

window.addEventListener("hashchange", route);
boot();
