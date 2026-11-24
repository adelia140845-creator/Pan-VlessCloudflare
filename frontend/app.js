import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { redeployPlan, redeployProgressLine, rateLimitInfo, summarizeRedeploy, ensureSubToken, withSubToken, createSubToken, appendHealthSample, summarizeHealthHistory, formatCheckedAt, poolAgeLabel, versionStateFromHealth, pruneHealthCache, healthSampleFromProbe, WORKER_HEALTH_CACHE_KEY, subUrlUuid, cfSecretNeedsEmail, parseWorkerEdit, parseWorkerBatch, parseSubToken } from "./redeploy.js";
import { qrTargets, renderQrInto } from "./qr.js";
import { countryOptionList, resolveCountry } from "./countries.js";
import { serializeState, parseState } from "./backup.js";
import { deployLogRows, deployLogRow, deployLogMissing, deployLogLine, DEPLOY_LOG_TABLE, DEPLOY_LOG_RPC, DEPLOY_LOG_LIMIT, deployLogRpcArgs, deployLogHistoryState } from "./deploy-log.js";
import { loginWithFallback, registerWithFallback, rpcMissing, rpcErrorMessage, throttleMessage } from "./auth-flow.js";

const SUPABASE_URL = "https://lumbbmhhmkcnxunuryjr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bWJibWhobWtjbnh1bnVyeWpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzI1MjEsImV4cCI6MjExMDA0ODUyMX0.ylMqMgv2H4vWax-whnXSRHBlD7DZs9DXVRUD9fAO6mc";
const supabase = SUPABASE_URL !== "ISI_URL_SUPABASE_DISINI" ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
// Scanner Go (panproxyscanner) menjalankan operasi yang butuh service key, mis. bersihkan baris
// mati proxy_pool. Panel hanya memanggilnya; kunci istimewa tidak pernah sampai ke browser.
const SCANNER_URL = "https://panproxyscanner.jhopan.my.id";

const $ = (id) => document.getElementById(id);
const usersKey = "CFVPN-vpn-panel-users";
const sessionKey = "CFVPN-vpn-panel-session";
const emptyState = { generatedCount: 0, workers: [] };
const protectedPages = new Set(["index.html", "workers.html", "generator.html", "deploy.html", "admin.html"]);

// Constants for generator
const ALLOWED_PORTS = new Set(["80", "443"]);
const ALLOWED_PROTOCOLS = new Set(["vless", "trojan", "ss"]);
const ALLOWED_FORMATS = new Set(["raw", "v2ray", "clash", "sfa", "bfr"]);

function getFlagEmoji(cc) {
  if (!/^[a-zA-Z]{2}$/.test(cc)) return "";
  return String.fromCodePoint(...cc.toUpperCase().split("").map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
}

function shuffleArray(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function generateClashYaml(configs) {
  const proxies = configs.map((c) => {
    const u = new URL(c);
    if (u.protocol !== "vless:") return ""; // Simplified: trojan/ss mapping belum ada
    // Baris dirakit sebagai daftar supaya tidak ada string multi-baris (dulu sempat merusak
    // seluruh file dengan SyntaxError saat menambah skip-cert-verify).
    const lines = [
      `  - name: "${decodeURIComponent(u.hash.slice(1))}"`,
      "    type: vless",
      `    server: ${u.hostname}`,
      `    port: ${u.port}`,
      `    uuid: ${u.username}`,
      "    udp: true",
      `    tls: ${u.searchParams.get("security") === "tls"}`,
    ];
    if (u.searchParams.get("allowInsecure") === "1") lines.push("    skip-cert-verify: true");
    lines.push(
      "    network: ws",
      `    servername: ${u.searchParams.get("sni") || u.hostname}`,
      "    ws-opts:",
      `      path: "${u.searchParams.get("path") || "/"}"`,
      "      headers:",
      `        Host: ${u.searchParams.get("host") || u.hostname}`,
    );
    return lines.join("\n");
  }).filter(Boolean).join("\n");

  return `proxies:\n${proxies}`;
}

function generateSingboxJson(configs) {
  const outbounds = configs.map((c, i) => {
    const u = new URL(c);
    if (u.protocol === "vless:") {
      return {
        type: "vless",
        tag: decodeURIComponent(u.hash.slice(1)),
        server: u.hostname,
        server_port: parseInt(u.port),
        uuid: u.username,
        tls: u.searchParams.get("security") === "tls" ? { enabled: true, server_name: u.searchParams.get("sni") || u.hostname, insecure: u.searchParams.get("allowInsecure") === "1" } : undefined,
        transport: { type: "ws", path: u.searchParams.get("path") || "/", headers: { Host: u.searchParams.get("host") || u.hostname } }
      };
    }
    return null;
  }).filter(Boolean);
  
  return JSON.stringify({ outbounds }, null, 2);
}

// Satu tempat pemetaan mode rotasi Generator -> perilaku (dipakai pratinjau dan pembuat config):
//   off     = daftar proxy disaring filter negara, panel memilih satu proxy
//   all     = path /ALL, filter negara TIDAK dipakai (worker yang memilih proxy)
//   country = path /<CC,...>, wajib ada negara terpilih (path kosong = jangan kirim config)
function rotationPlan(mode, ccList) {
  const cc = (ccList || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean);
  if (mode === "all") return { rotate: true, ccList: [], path: "/ALL" };
  if (mode === "country") return { rotate: true, ccList: cc, path: cc.length ? "/" + cc.join(",") : "" };
  return { rotate: false, ccList: cc };
}

async function generateLocalConfigs(params) {
  // Mode rotasi: worker yang memilih proxy sendiri (path /rotate), jadi tidak perlu daftar
  // proxy sama sekali — satu config, dan tidak perlu diganti saat pool berubah.
  if (params.rotate) {
    const bound = (state.workers || []).find((w) => w.host === params.host && w.uuid);
    const uuid = bound ? bound.uuid : crypto.randomUUID();
    const port = params.portList[0] || "443";
    const tls = port === "443";
    // Semua negara terpilih menjadi selector path: /ID, /ID,SG, atau /ALL kalau kosong.
    const countryList = (params.ccList || []).map((cc) => String(cc).trim().toUpperCase()).filter((cc) => /^[A-Z]{2}$/.test(cc));
    const country = [...new Set(countryList)].join(",");
    const path = country ? "/" + country : "/ALL";
    // `sni` hanya ditulis kalau TLS: parameter kosong membuat sebagian klien menolak config.
    const query = new URLSearchParams({
      encryption: "none", type: "ws", host: params.host,
      security: tls ? "tls" : "none", path,
    });
    if (tls) query.set("sni", params.host);
    if (tls && params.insecure) query.set("allowInsecure", "1");
    const label = `1 Pan-VlessCloudflare WS ${tls ? "TLS" : "NTLS"} [${country || "ALL"}] [${params.serviceName}]`;
    return formatConfigs([`vless://${uuid}@${params.host}:${port}?${query}#${encodeURIComponent(label)}`], params.format);
  }

  let proxies = [];
  
  if (params.customProxyList && params.customProxyList.length > 0) {
    proxies = params.customProxyList.map(item => {
      let ip = item;
      let port = "443";
      if (item.includes(":")) {
        const parts = item.split(":");
        ip = parts[0];
        port = parts[1];
      }
      return {
        prxIP: ip,
        prxPort: port,
        country: "XX",
        org: "Custom Proxy"
      };
    });
  } else if (supabase) {
    // Hanya proxy yang benar-benar hidup: is_active + ping bagus + cek tidak basi
    const freshLimit = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    let query = supabase.from('proxy_pool').select('*').eq('is_active', true).gt('last_checked', freshLimit);
    if (params.ccList && params.ccList.length > 0) {
      query = query.in('country', params.ccList);
    }
    const { data, error } = await query;
    if (!error && data && data.length > 0) {
      proxies = data.map(p => ({
        prxIP: p.ip,
        prxPort: p.port,
        country: p.country || "DB",
        org: p.org || "Cloud"
      }));
    }
  }
  
  if (!proxies.length) {
    throw new Error("Tidak ada proxy aktif. Coba ubah filter negara/penyedia.");
  }
  
  shuffleArray(proxies);

  // Kalau worker ini dikunci dengan UUID saat deploy (binding UUID_ALLOWLIST), pakai UUID itu —
  // kalau tidak, worker akan menolak koneksi.
  const boundWorker = (state.workers || []).find((w) => w.host === params.host && w.uuid);
  const uuid = boundWorker ? boundWorker.uuid : crypto.randomUUID();
  const configs = [];
  outer: for (const proxy of proxies) {
    for (const port of params.portList) {
      if (configs.length >= params.limit) break outer;
      const tls = port === "443";
      const path = `/${proxy.prxIP}-${proxy.prxPort}`;
      const label = `${configs.length + 1} ${getFlagEmoji(proxy.country)} ${proxy.org} WS ${tls ? "TLS" : "NTLS"} [${params.serviceName}]`;
      
      const query = new URLSearchParams({ encryption: "none", type: "ws", host: params.host, security: tls ? "tls" : "none", path });
      if (tls) query.set("sni", params.host);
      if (tls && params.insecure) query.set("allowInsecure", "1");
      const config = `vless://${uuid}@${params.host}:${port}?${query}#${encodeURIComponent(label)}`;
      configs.push(config);
    }
  }

  if (!configs.length) throw new Error("Proxy tidak ditemukan untuk negara pilihan.");
  return formatConfigs(configs, params.format);
}

// Formatkan daftar VLESS URI sesuai pilihan output (dipakai jalur normal maupun mode rotate).
function formatConfigs(configs, format) {
  if (format === "v2ray") return btoa(configs.join("\n"));
  if (format === "clash") return generateClashYaml(configs);
  if (format === "sfa" || format === "bfr") return generateSingboxJson(configs);
  return configs.join("\n");
}


// Cloudflare Pages menyajikan /admin.html sebagai /admin (308) dan /index.html sebagai /, jadi
// nama halaman dinormalkan ke bentuk "*.html" lebih dulu — tanpa itu gerbang di checkAuth
// (protectedPages, halaman admin) tidak pernah cocok dengan URL yang benar-benar dibuka pengunjung.
function pageName() {
  const name = location.pathname.split("/").pop() || "";
  if (!name) return "index.html";
  return name.includes(".") ? name : name + ".html";
}

let state = { ...emptyState };
let currentUser = null; // now holds { username: string }

// Sesi di localStorage hanya bisa dipercaya kalau server membenarkan `hash`-nya. Sebelum ini
// setiap halaman selain users_custom cuma digerbangi session di localStorage, jadi siapa pun bisa
// membuka halaman admin dengan menulis `role: "admin"` sendiri di console (aksi admin sendiri tetap
// butuh hash yang diverifikasi admin_action). whoami (sql/2026-11-14-whoami.sql) memindahkan
// pemeriksaan itu ke server dan mengembalikan role yang sebenarnya.
//
// Hasil: "ok" (role di currentUser sudah dari server), "invalid" (hash tidak cocok => sesi palsu
// atau basi), "skipped" (RPC belum ada, atau sesi tidak membawa hash => perilaku lama apa adanya).
async function verifySession() {
  if (!currentUser || !supabase) return "skipped";
  const username = typeof currentUser.username === "string" ? currentUser.username : "";
  const hash = typeof currentUser.hash === "string" ? currentUser.hash : "";
  if (!username || !hash) return "skipped";

  const viaRpc = await supabase.rpc("whoami", { p_username: username, p_hash: hash });
  if (viaRpc.error) {
    if (rpcMissing(viaRpc.error)) return "skipped";
    // RPC ada tapi gagal (jaringan/DB): jangan mengunci orang karena gangguan sesaat.
    console.warn("whoami gagal:", rpcErrorMessage(viaRpc.error));
    return "skipped";
  }

  // NULL/kosong = tidak ada baris yang cocok. Role yang dipakai UI selalu dari sini.
  const role = typeof viaRpc.data === "string" ? viaRpc.data.trim() : "";
  if (!role) return "invalid";
  currentUser = { ...currentUser, role: role };
  return "ok";
}

async function checkAuth() {
  const s = localStorage.getItem(sessionKey);
  currentUser = s ? JSON.parse(s) : null;

  const page = pageName();
  const isProtected = protectedPages.has(page);
  const isAuthPage = page === "login.html" || page === "register.html";

  const verdict = await verifySession();
  if (verdict === "invalid") {
    localStorage.removeItem(sessionKey);
    currentUser = null;
    // Di halaman login/daftar sudah berada di tempat yang benar (dan halaman itu tidak direload
    // supaya isian form tidak hilang); di halaman lain sesi palsu dilempar ke login.
    if (!isAuthPage) {
      location.replace("login.html");
      return false;
    }
  }

  if (isProtected && !currentUser) {
    location.replace("landing.html");
    return false;
  }
  if (isAuthPage && currentUser) {
    location.replace("index.html");
    return false;
  }
  // Admin page: only admin role — dari hasil whoami, bukan `role` di localStorage.
  if (page === "admin.html" && currentUser?.role !== "admin") {
    location.replace("index.html");
    return false;
  }
  return true;
}

// State per user: dua fase seperti auth. Setelah sql/2026-11-14-state-hardening.sql, tabel
// user_states tidak bisa dibaca/ditulis anon dan semuanya lewat RPC yang memverifikasi hash
// pemiliknya — jadi sesi palsu tidak bisa menimpa daftar worker user lain.
async function loadState() {
  if (!currentUser) return;
  const stateId = currentUser.username;

  if (!supabase) {
    const saved = localStorage.getItem(`state-${stateId}`);
    state = saved ? { ...emptyState, ...JSON.parse(saved) } : { ...emptyState };
    return;
  }

  if (currentUser.hash) {
    const viaRpc = await supabase.rpc("get_state", { p_username: stateId, p_actor_hash: currentUser.hash });
    if (!viaRpc.error) {
      state = viaRpc.data ? { ...emptyState, ...viaRpc.data } : { ...emptyState };
      return;
    }
    if (!rpcMissing(viaRpc.error)) {
      console.warn("get_state ditolak:", rpcErrorMessage(viaRpc.error));
      state = { ...emptyState };
      return;
    }
  }

  const { data } = await supabase.from('user_states').select('state_data').eq('username', stateId).maybeSingle();
  state = data && data.state_data ? { ...emptyState, ...data.state_data } : { ...emptyState };
}

async function saveState() {
  if (!currentUser) return;
  const stateId = currentUser.username;

  if (!supabase) {
    localStorage.setItem(`state-${stateId}`, JSON.stringify(state));
    return;
  }

  if (currentUser.hash) {
    const viaRpc = await supabase.rpc("save_state", { p_username: stateId, p_actor_hash: currentUser.hash, p_state: state });
    if (!viaRpc.error) return;
    if (!rpcMissing(viaRpc.error)) {
      console.warn("save_state ditolak:", rpcErrorMessage(viaRpc.error));
      return;
    }
  }

  await supabase.from('user_states').upsert({
    username: stateId,
    state_data: state,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'username' });
}

function typeLabel(type) { return type === "load_balancer" ? "Load Balancer" : "VPN Worker"; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function activeWorkers(type) { return state.workers.filter((worker) => worker.active && (!type || worker.type === type)); }
// setOptional menulis kolom opsional worker: nilai `undefined` (dari parseWorkerEdit saat isian
// dikosongkan) MENGHAPUS kolom itu dari state, bukan menyisakan nilai lama.
function setOptional(target, key, value) {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function setMessage(id, message = "", error = false) { const el = $(id); if (!el) return; el.textContent = message; el.classList.toggle("error", error); }
function requireAuth() { return true; } // Diganti checkAuth()

function renderNav() {
  const displayId = currentUser ? currentUser.username : "";
  const role = currentUser?.role || "user";
  document.querySelectorAll("[data-user-email]").forEach((el) => {
    el.innerHTML = `${escapeHtml(displayId)} <span class="role-badge ${role}">${role}</span>`;
  });
  // Show user management nav if admin
  const adminNav = $("adminNav");
  if (adminNav && role === "admin") adminNav.hidden = false;
  const adminStat = $("adminUserStat");
  if (adminStat && role === "admin") adminStat.hidden = false;
  // Halaman Status (kondisi pool + cron) hanya untuk admin; tautannya disembunyikan di HTML
  // supaya pengguna biasa tidak melihat menu yang isinya cuma pesan "khusus admin".
  const statusNav = $("statusNav");
  if (statusNav && role === "admin") statusNav.hidden = false;
  $("logoutButton")?.addEventListener("click", () => { 
    localStorage.removeItem(sessionKey); 
    location.href = "login.html"; 
  });

  // Show admin toolbars if admin
  if (role === "admin") {
    document.querySelectorAll(".admin-toolbar").forEach(el => el.hidden = false);
    
    // Generator admin toolbar
    const genRefresh = $("genRefreshCache");
    if (genRefresh) genRefresh.onclick = () => {
      localStorage.removeItem("proxyPickerCache");
      localStorage.removeItem("proxyActiveCountCache");
      location.reload();
    };
    const genCron = $("genForceCron");
    if (genCron) genCron.onclick = async () => {
      genCron.disabled = true; genCron.textContent = "Menjalankan...";
      try { await fetch("https://proxy-cron-worker.adelia140845.workers.dev/trigger"); } catch {}
      setTimeout(() => { genCron.disabled = false; genCron.textContent = "Force Cron"; }, 3000);
    };

    // Proxy admin toolbar
    const proxyRefresh = $("proxyRefreshBtn");
    if (proxyRefresh) proxyRefresh.onclick = () => {
      localStorage.removeItem("proxyListCache");
      localStorage.removeItem("proxyPickerCache");
      localStorage.removeItem("proxyActiveCountCache");
      location.reload();
    };
    const proxyCron = $("proxyForceCron");
    if (proxyCron) proxyCron.onclick = async () => {
      proxyCron.disabled = true; proxyCron.textContent = "Menjalankan...";
      try { await fetch("https://proxy-cron-worker.adelia140845.workers.dev/trigger"); } catch {}
      setTimeout(() => { proxyCron.disabled = false; proxyCron.textContent = "Force Cron"; }, 3000);
    };
    const proxyDelDead = $("proxyDeleteDeadBtn");
    if (proxyDelDead) proxyDelDead.onclick = async () => {
      if (!confirm("Hapus semua proxy mati?")) return;
      proxyDelDead.disabled = true;
      proxyDelDead.textContent = "Menghapus...";
      try {
        // DELETE proxy_pool dikerjakan scanner Go (panproxyscanner), bukan browser dan bukan
        // Pages Function: anon key tidak lagi punya izin hapus
        // (sql/2026-11-15-pool-prune-service-key.sql) dan service key hanya ada di scanner.
        // Scanner memverifikasi sesi panel lewat RPC whoami (role wajib admin) lalu menghapus
        // dengan service key. Panel TIDAK boleh fallback ke supabase.from(...).
        const res = await fetch(`${SCANNER_URL}/api/pool-purge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: currentUser?.username || "", hash: currentUser?.hash || "" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Pesan server sudah spesifik (service key belum diset, migrasi belum jalan, sesi
          // tidak valid); fallback hanya untuk balasan tanpa error.
          const fallback =
            res.status === 401 ? "Sesi tidak valid. Login ulang dulu."
            : res.status === 403 ? "Hanya admin yang boleh menghapus baris proxy."
            : res.status === 409 ? "Migrasi SQL auth belum dijalankan di server."
            : res.status === 503 ? "Fitur ini belum siap di server (service key belum diset)."
            : res.status === 429 ? "Terlalu banyak permintaan. Coba lagi sebentar."
            : "Gagal menghapus baris mati (HTTP " + res.status + ").";
          setMessage("dbProxyMessage", data.error || fallback, true);
          return;
        }
        localStorage.removeItem("proxyListCache");
        location.reload();
      } catch (error) {
        setMessage("dbProxyMessage", "Gagal menghubungi server: " + error.message, true);
      } finally {
        proxyDelDead.disabled = false;
        proxyDelDead.textContent = "Hapus Mati";
      }
    };
  }
}
function renderDashboard() {
  if (!$("activeWorkerCount")) return;
  $("activeWorkerCount").textContent = state.workers.filter((w) => w.active).length;
  $("generatedCount").textContent = state.generatedCount;
  // Admin: fetch total users
  if (currentUser?.role === "admin" && supabase) {
    (async () => {
      const el = $("statTotalUsers");
      if (!el) return;
      try {
        const { count } = await supabase.from("users_custom").select("username", { count: "exact", head: true });
        el.textContent = count ?? 0;
      } catch { el.textContent = "0"; }
    })();
  }
  (async () => {
    const el = $("activeProxyCount");
    if (!el) return;
    const CACHE_KEY = "proxyActiveCountCache";
    const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 jam
    // 1. Cek cache localStorage dulu
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
        el.textContent = cached.count;
        return; // cache masih segar, tidak query Supabase
      }
    } catch {}
    // 2. Cache kedaluwarsa atau tidak ada → fetch baru
    try {
      let count = 0;
      if (supabase) {
        const { count: dbCount } = await supabase.from("proxy_pool").select("*", { count: "exact", head: true }).eq("is_active", true);
        if (dbCount != null) count = dbCount;
      }
      el.textContent = count;
      localStorage.setItem(CACHE_KEY, JSON.stringify({ count, ts: Date.now() }));
    } catch { el.textContent = 0; }
  })();

  // ---- Export/Import state + riwayat deploy (audit) -------------------------------------
  // Semua di dalam penjaga elemen: index.html versi deploy lama (belum punya blok ini) tidak
  // boleh melempar error hanya karena tombolnya tidak ada.
  const exportBtn = $("exportStateBtn");
  const importBtn = $("importStateBtn");
  const importFile = $("importStateFile");

  if (exportBtn) {
    exportBtn.onclick = () => {
      const workers = Array.isArray(state.workers) ? state.workers : [];
      // Blob + <a download>: tanpa jaringan sama sekali, jadi export tetap jalan walau Supabase
      // sedang bermasalah. Metadata (format/versi/waktu/username) ditulis backup.js.
      const text = serializeState(state, { username: currentUser?.username || "" });
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `pan-vlesscloudflare-state-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); // unduhan sudah diambil browser
      setMessage("backupMessage", `Export selesai: ${workers.length} worker (${(text.length / 1024).toFixed(1)} KB).`);
    };
  }

  if (importBtn && importFile) {
    importBtn.onclick = () => importFile.click();
    importFile.onchange = async () => {
      const file = importFile.files && importFile.files[0];
      // Input dikosongkan supaya berkas yang sama bisa dipilih ulang setelah import ditolak.
      importFile.value = "";
      if (!file) return;

      let text = "";
      try {
        text = await file.text();
      } catch (error) {
        setMessage("backupMessage", "Gagal membaca berkas: " + (error && error.message ? error.message : error), true);
        return;
      }

      // Validasi DULU, konfirmasi SESUDAH: berkas rusak ditolak sebelum state disentuh, jadi
      // state lama tetap utuh (tidak ada saveState, tidak ada perubahan di layar).
      const parsed = parseState(text);
      if (!parsed.ok) {
        setMessage("backupMessage", "Import ditolak: " + parsed.error, true);
        return;
      }

      const incoming = parsed.state.workers.length;
      const current = Array.isArray(state.workers) ? state.workers.length : 0;
      const duplicateNote = parsed.duplicates ? ` ${parsed.duplicates} entri ber-id duplikat dibuang.` : "";
      if (!window.confirm(`Import ${incoming} worker dari "${file.name}"? State sekarang (${current} worker) akan DIGANTI.${duplicateNote}`)) {
        setMessage("backupMessage", "Import dibatalkan. State tidak berubah.");
        return;
      }

      state = parsed.state;
      await saveState();
      renderDashboard(); // kartu statistik (jumlah worker aktif) ikut berubah
      renderWorkers();
      setMessage(
        "backupMessage",
        `Import selesai: ${incoming} worker dimuat${parsed.duplicates ? ` (${parsed.duplicates} duplikat dibuang)` : ""}.`
      );
    };
  }

  renderDeployLog();
}

// Riwayat deploy (audit): 20 baris terakhir, dibaca lewat RPC ber-hash
// (public.deploy_log_list, lihat sql/2026-11-15-deploy-log.sql). Anon memang TIDAK punya hak
// SELECT pada tabelnya — riwayat memuat username + nama/host worker semua akun, jadi pembacaan
// harus lewat RPC yang memverifikasi hash sesi dan yang menentukan admin (semua akun) vs user
// biasa (barisnya sendiri). Tabel/RPC yang belum ada hanya menghasilkan catatan "migrasi belum
// dijalankan", bukan error, karena deploy sendiri tetap berjalan.
async function renderDeployLog() {
  const list = $("deployLogList");
  if (!list || !supabase) return;

  const hash = typeof currentUser?.hash === "string" ? currentUser.hash : "";
  let outcome = { message: "", error: false, rows: [] };
  try {
    const { data, error } = await supabase.rpc(
      DEPLOY_LOG_RPC,
      deployLogRpcArgs(currentUser?.username || "", hash, DEPLOY_LOG_LIMIT)
    );
    outcome = deployLogHistoryState({ rows: data, error, hasHash: Boolean(hash) });
  } catch (error) {
    // Gangguan jaringan: sama seperti galat lain, pesannya singkat dan rapi (detail ke konsol).
    outcome = deployLogHistoryState({ error: { message: rpcErrorMessage(error) }, hasHash: Boolean(hash) });
    console.warn("riwayat deploy gagal dimuat:", rpcErrorMessage(error));
  }

  list.innerHTML = outcome.rows.map((row) => `<code>${escapeHtml(deployLogLine(row))}</code>`).join("");
  setMessage("deployLogMessage", outcome.message, outcome.error);
}
// Versi template worker yang terpasang di frontend ini. Harus sama dengan WORKER_VERSION di
// frontend/source/panvlesscloudflare.js: /health mengembalikannya, jadi panel bisa menandai worker
// yang masih versi lama dan menawarkan deploy ulang.
const WORKER_TEMPLATE_VERSION = "2026-11-15b";
// Versi template Load Balancer, pasangan LB_VERSION di frontend/source/load-balancer.js.
// Dipisah dari versi VPN karena keduanya template yang berbeda: /health tiap worker membalas
// jenisnya sendiri (`type`), jadi versi LB tidak pernah dibandingkan dengan versi VPN.
const LB_TEMPLATE_VERSION = "2026-11-17d";
// Batas tunggu satu pemeriksaan /health. Worker yang tidak menjawab dalam waktu ini dihitung
// mati (tidak terjangkau), bukan menggantung tombol "Cek semua".
const HEALTH_TIMEOUT_MS = 6000;

// --- Riwayat uptime /health per worker ---------------------------------------
// Tiap pemeriksaan disimpan di localStorage (WORKER_HEALTH_CACHE_KEY) sebagai HEALTH_HISTORY_LIMIT
// sampel terakhir per worker, dan ringkasannya yang dirender di kartu. Dengan begitu halaman yang
// baru dibuka sudah menampilkan bukti pemeriksaan terakhir sebelum pemeriksaan baru selesai.

function readHealthCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKER_HEALTH_CACHE_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeHealthCache(cache) {
  try { localStorage.setItem(WORKER_HEALTH_CACHE_KEY, JSON.stringify(cache)); } catch {}
}

// probeWorker menjalankan satu pemeriksaan /health dan mengukur latensinya. Latensi diukur di
// sekitar fetch (waktu tempuh ke edge worker), bukan dari isi balasan.
async function probeWorker(worker) {
  const started = performance.now();
  try {
    const res = await fetch(`https://${worker.host}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const latencyMs = performance.now() - started;
    let version = null;
    let type = null;
    // Balasan tanpa JSON (template lama: VPN mengembalikan teks biasa, LB dulu juga) bukan
    // kegagalan — itu hanya berarti versi dan jenis worker tidak diketahui.
    try {
      const data = await res.json();
      if (data && typeof data.version === "string") version = data.version;
      if (data && typeof data.type === "string") type = data.type;
    } catch {}
    return healthSampleFromProbe({ at: Date.now(), latencyMs, status: res.status, reachable: true, version, type });
  } catch (error) {
    return healthSampleFromProbe({
      at: Date.now(),
      latencyMs: performance.now() - started,
      status: 0,
      reachable: false,
      error: (error && error.message) || "tidak terjangkau",
    });
  }
}

// recordHealthSample menyimpan satu sampel ke cache dan langsung menyegarkan blok kartunya.
function recordHealthSample(worker, sample) {
  const cache = readHealthCache();
  cache[worker.id] = appendHealthSample(cache[worker.id], sample);
  writeHealthCache(cache);
  renderHealthBlock(worker.id);
}

// checkedThisSession berisi worker yang benar-benar diperiksa manual di halaman ini. Kartu worker
// tidak lagi memanggil /health sendiri (hemat jatah request worker), jadi blok kesehatan/uptime hanya
// muncul untuk hasil pemeriksaan yang pengguna minta.
const checkedThisSession = new Set();

function healthBlockHtml(worker) {
  if (!checkedThisSession.has(worker.id)) return "";
  const summary = summarizeHealthHistory(readHealthCache()[worker.id]);
  const last = summary.last;
  const badge = !last
    ? `<span class="badge">belum dicek</span>`
    : summary.lastUp
      ? `<span class="badge">hidup${summary.lastStatus >= 400 ? ` (HTTP ${summary.lastStatus})` : ""}</span>`
      : `<span class="badge" style="border-color:var(--warn)">mati${summary.lastStatus ? ` (HTTP ${summary.lastStatus})` : " (tidak terjangkau)"}</span>`;

  const latency = summary.lastLatencyMs != null ? ` · ${summary.lastLatencyMs} ms` : "";
  const uptime = summary.checks
    ? `uptime ${summary.uptimePct}% dari ${summary.checks} cek terakhir${summary.avgLatencyMs != null ? ` · rata-rata ${summary.avgLatencyMs} ms` : ""}`
    : "belum ada riwayat pemeriksaan";

  const state = versionStateFromHealth(
    { type: summary.lastType, version: summary.lastVersion },
    worker.type,
    { vpn: WORKER_TEMPLATE_VERSION, load_balancer: LB_TEMPLATE_VERSION }
  );
  const version = state === "current"
    ? "versi terbaru"
    : state === "stale"
      ? `versi lama (${escapeHtml(summary.lastVersion)}) · <a href="${deployLink(worker)}">deploy ulang</a>`
      : "versi tidak diketahui";

  const error = summary.lastError ? `<div>${escapeHtml(summary.lastError)}</div>` : "";
  return `<div>${badge} dicek ${escapeHtml(formatCheckedAt(summary.lastAt))}${latency}</div><div>${uptime} · ${version}</div>${error}`;
}

// deployLink: tautan "deploy ulang" satu worker ke halaman Deploy (nama, jenis, dan UUID-nya).
function deployLink(worker) {
  return `deploy.html?name=${encodeURIComponent(worker.name)}&type=${encodeURIComponent(worker.type)}&uuid=${encodeURIComponent(worker.uuid || "")}`;
}

function renderHealthBlock(workerId) {
  const el = document.querySelector(`[data-health="${workerId}"]`);
  const worker = state.workers.find((item) => item.id === workerId);
  if (!el || !worker) return;
  el.innerHTML = healthBlockHtml(worker);
}

// Pemeriksaan otomatis saat halaman dirender: paralel supaya tidak menahan render, dan hanya
// worker aktif yang diperiksa (worker nonaktif memang tidak diharapkan menjawab).
async function checkWorkerHealth(workers) {
  await Promise.all(
    workers
      .filter((w) => w.active)
      .map(async (worker) => { const sample = await probeWorker(worker); checkedThisSession.add(worker.id); return recordHealthSample(worker, sample); })
  );
}

// Tombol "Cek semua": BERURUTAN (satu per satu) supaya progresnya terlihat dan tidak membanjiri
// worker sekaligus. Ringkasan akhir menyebut worker mana yang tidak menjawab.
async function checkAllWorkerHealth() {
  const workers = state.workers.filter((worker) => worker.active);
  const button = $("checkAllHealth");

  if (!workers.length) {
    setMessage("workersMessage", "Tidak ada worker aktif yang bisa diperiksa.", true);
    return;
  }

  if (button) button.disabled = true;
  try {
    const results = [];
    for (let index = 0; index < workers.length; index += 1) {
      const worker = workers[index];
      setMessage("workersMessage", `memeriksa ${index + 1}/${workers.length}: ${worker.name}...`);
      const sample = await probeWorker(worker);
    checkedThisSession.add(worker.id);
      recordHealthSample(worker, sample);
      results.push({ name: worker.name, ok: sample.up });
      // Biarkan browser menggambar baris progres sebelum worker berikutnya diperiksa.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const down = results.filter((item) => !item.ok);
    setMessage(
      "workersMessage",
      down.length
        ? `Selesai: ${results.length - down.length}/${results.length} worker hidup. Tidak menjawab: ${down.map((item) => item.name).join(", ")}.`
        : `Selesai: semua ${results.length} worker aktif menjawab /health.`,
      down.length > 0
    );
  } finally {
    if (button) button.disabled = false;
  }
}

// Tombol "Ganti token" di kartu Load Balancer: membuat token langganan BARU dan menyimpannya ke
// entri worker. Token baru dipasang ke worker hanya oleh deploy (batch "Deploy ulang semua" di
// halaman Deploy memakai token tersimpan) — halaman ini tidak menyimpan kredensial Cloudflare,
// jadi tombol ini sengaja tidak mendeploy sendiri.
async function rotateSubToken(worker) {
  const sure = window.confirm(
    `Buat token langganan baru untuk ${worker.name}?\n\n` +
      "Tautan langganan lama AKAN MATI setelah kamu menekan \"Deploy ulang semua\" di halaman Deploy. " +
      "Sampai deploy itu dijalankan, worker masih memakai token lama."
  );
  if (!sure) return;

  worker.sub_token = createSubToken();
  await saveState();
  renderWorkers();
  setMessage(
    "workersMessage",
    "Token baru dibuat — klik \"Deploy ulang semua\" di halaman Deploy untuk memasangnya. Tautan lama baru mati setelah deploy itu."
  );
}

// Tombol "Tetapkan token": menulis token langganan yang SUDAH dimiliki pengguna ke state, tanpa
// memanggil Cloudflare sama sekali (tidak ada kredensial di halaman ini). Worker baru benar-benar
// memakai token itu setelah "Deploy ulang semua" di halaman Deploy — itulah sebabnya tombol ini
// aman ditekan berkali-kali.
function setSubToken(worker) {
  const answer = window.prompt(`Token langganan ${worker.name} (32 karakter hex):`, worker.sub_token || "");
  if (answer === null) return;

  const parsed = parseSubToken(answer);
  if (!parsed.ok) return setMessage("workersMessage", parsed.error, true);

  worker.sub_token = parsed.token;
  saveState();
  renderWorkers();
  setMessage("workersMessage", `Token langganan ${worker.name} disimpan. Klik "Deploy ulang semua" di halaman Deploy untuk memasangnya ke worker.`);
}

// renderWorkers menggambar kartu worker.
function renderWorkers() {
  if (!$("workerList")) return;
  $("emptyWorkers").hidden = state.workers.length > 0;

  const vpnWorkers = state.workers.filter(w => w.type === "vpn");
  const lbWorkers = state.workers.filter(w => w.type === "load_balancer");

  const cardHtml = (worker) => {
    let extra = "";
    if (worker.type === "load_balancer") {
      const domains = worker.vpn_domains || [];
      const subUuid = subUrlUuid(domains, state.workers);
      const subUrl = withSubToken(`${worker.host}/api/v1/sub?format=raw&limit=20${domains.length ? "&domains=" + domains.join(",") : ""}${subUuid ? "&uuid=" + subUuid : ""}&insecure=1`, worker.sub_token);
      // Token langganan hanya dipasang ke worker oleh deploy (batch "Deploy ulang semua"),
      // halaman ini tidak menyimpan kredensial Cloudflare.
      const tokenNote = worker.sub_token
        ? ""
        : "Belum ada token langganan tersimpan — URL di atas masih terbuka tanpa token. \"Tetapkan token\" menulis token yang sudah kamu punya, \"Ganti token\" membuat yang baru.";
      // LB tanpa token: URL langganannya terbuka. Menambahkannya NANTI (lewat Ganti token +
      // "Deploy ulang semua") mematikan tautan lama yang belum memuat `t=`, jadi peringatannya
      // ditampilkan sebelum orang menekan deploy ulang — bukan sesudahnya.
      const tokenBadge = worker.sub_token
        ? ""
        : `<div style="margin-top:6px"><span class="badge" style="border-color:#f59e0b;color:#fcd34d">token langganan belum ada — tautan lama berisiko mati saat "Deploy ulang semua"</span></div>`;
      const subRow = `<div class="sub-row"><code class="sub-url">${escapeHtml(subUrl)}</code><button class="icon-button" data-copy-sub="${escapeHtml(subUrl)}" type="button">Copy</button></div>`;
      extra = `<div class="lb-details"><div class="lb-domains"><span class="eyebrow">VPN Worker terhubung</span><code>${domains.length ? escapeHtml(domains.join(", ")) : "<i>Belum ada</i>"}</code></div><div class="lb-sub"><span class="eyebrow">URL Subscription</span>${subRow}</div><div class="form-actions" style="margin-top:8px"><button class="icon-button" data-rotate-sub="${worker.id}" type="button">Ganti token</button><button class="icon-button" data-set-token="${worker.id}" type="button">Tetapkan token</button></div><p class="form-message" style="min-height:0">${tokenNote}</p>${tokenBadge}</div>`;
    }

    const usage = worker.type === "vpn" ? `<a class="icon-button" href="generator.html?worker=${worker.id}">Pakai</a>` : "";

    // Input sakelar aktif sengaja diberi pointer-events:none: inputnya (position:absolute, opacity:0)
    // dulu menutupi tombol di belakangnya sehingga klik "Hapus" tidak sampai. Label tetap men-toggle
    // kontrolnya, sedangkan tombol di sebelahnya bisa diklik lagi.
    return `<article class="worker-card worker-card-lb"><div class="worker-card-head"><div><p class="worker-title">${escapeHtml(worker.name)}</p><code>${escapeHtml(worker.host)}</code></div><div class="worker-meta"><span class="type">${typeLabel(worker.type)}</span><label class="switch"><input data-toggle="${worker.id}" type="checkbox" ${worker.active ? "checked" : ""} style="pointer-events:none"><span></span><b>${worker.active ? "Aktif" : "Nonaktif"}</b></label>${usage}<button class="icon-button" data-edit-worker="${worker.id}" type="button">Edit</button><button class="icon-button danger" data-delete="${worker.id}" type="button">Hapus</button></div></div>${extra}<div class="health" data-health="${worker.id}" style="margin-top:10px">${healthBlockHtml(worker)}</div></article>`;
  };

  const sectionHtml = (title, count, workers) => {
    if (!workers.length) return "";
    return `<div class="worker-section"><div class="worker-section-head"><h3>${title}</h3><span class="badge">${count} aktif</span></div><div class="worker-grid">${workers.map(cardHtml).join("")}</div></div>`;
  };

  // Riwayat milik worker yang sudah dihapus dibuang supaya localStorage tidak tumbuh terus.
  const storedHealth = readHealthCache();
  const keptHealth = pruneHealthCache(storedHealth, state.workers);
  if (Object.keys(keptHealth).length !== Object.keys(storedHealth).length) writeHealthCache(keptHealth);

  $("workerList").innerHTML =
    sectionHtml("VPN Worker", vpnWorkers.filter(w => w.active).length, vpnWorkers) +
    sectionHtml("Load Balancer", lbWorkers.filter(w => w.active).length, lbWorkers);

  // Sengaja TIDAK ada pemeriksaan /health otomatis: setiap probe memakai jatah request worker yang
  // sama dengan tunnel klien, jadi halaman ini tidak boleh menembak worker sendiri. Pemeriksaan hanya
  // jalan saat tombolnya ditekan (lihat checkAllWorkerHealth).

  const checkAllButton = $("checkAllHealth");
  if (checkAllButton) checkAllButton.onclick = checkAllWorkerHealth;

  $("showAddWorker").onclick = () => {
    const form = $("addWorkerForm");
    form.reset();
    delete form.dataset.editId;
    form.querySelector("button[type=submit]").textContent = "Simpan Worker";
    $("vpnDomainsField").hidden = true;
    form.hidden = false;
  };
  $("cancelAddWorker").onclick = () => { $("addWorkerForm").hidden = true; $("addWorkerForm").reset(); $("vpnDomainsField").hidden = true; };

  // Show/hide VPN domains field based on type
  $("workerType").onchange = (e) => {
    $("vpnDomainsField").hidden = e.target.value !== "load_balancer";
  };

  $("addWorkerForm").onsubmit = (event) => {
    event.preventDefault();
    const form = event.target;
    // Satu validator untuk jalur tambah DAN edit (parseWorkerEdit di redeploy.js): host, UUID v4,
    // Account ID, dan daftar domain dinormalkan dengan aturan yang sama.
    const result = parseWorkerEdit({
      name: $("workerName").value,
      host: $("workerHost").value,
      type: $("workerType").value,
      uuid: $("workerUuid").value,
      vpnDomains: $("workerVpnDomains").value,
      accountId: $("workerAccountId").value,
    });
    if (!result.ok) return alert(result.error);

    const patch = result.worker;
    const editId = form.dataset.editId;
    const existing = editId ? state.workers.find(w => w.id === editId) : null;
    const worker = existing || { id: crypto.randomUUID(), active: true };
    worker.name = patch.name;
    worker.host = patch.host;
    worker.type = patch.type;
    setOptional(worker, "uuid", patch.uuid);
    setOptional(worker, "vpn_domains", patch.vpn_domains);
    setOptional(worker, "accountId", patch.accountId);
    if (!existing) state.workers.push(worker);

    delete form.dataset.editId;
    saveState();
    form.reset();
    form.hidden = true;
    $("vpnDomainsField").hidden = true;
    form.querySelector("button[type=submit]").textContent = "Simpan Worker";
    renderWorkers();
  };

  // Tambah batch: satu textarea untuk beberapa worker sekaligus (parseWorkerBatch di redeploy.js).
  // Jalur Edit di atas tidak disentuh — panelnya terpisah dari #addWorkerForm.
  $("showBatchWorkers").onclick = () => {
    const panel = $("batchPanel");
    panel.hidden = !panel.hidden;
  };

  $("batchAddWorkers").onclick = () => {
    // Host yang sudah ada sekaligus nama yang sudah dipakai diambil dari state (parseWorkerBatch
    // menerima objek worker apa adanya).
    const result = parseWorkerBatch($("batchWorkersInput").value, state.workers);
    const parts = [`${result.workers.length} worker ditambahkan`];
    if (result.skipped.length) {
      const reasons = [...new Set(result.skipped.map((item) => item.reason))].join(", ");
      parts.push(`${result.skipped.length} dilewati (${reasons})`);
    }
    if (result.errors.length) {
      parts.push(result.errors.map((item) => `error baris ${item.line}: ${item.reason}`).join(" · "));
    }
    setMessage("batchMessage", parts.join(" · "), result.errors.length > 0);

    // Tidak ada baris yang sah: state TIDAK disentuh sama sekali (tanpa saveState/render).
    if (!result.workers.length) return;

    for (const patch of result.workers) {
      const worker = { id: crypto.randomUUID(), active: true, source: "manual" };
      worker.name = patch.name;
      worker.host = patch.host;
      worker.type = patch.type;
      setOptional(worker, "uuid", patch.uuid);
      setOptional(worker, "vpn_domains", patch.vpn_domains);
      setOptional(worker, "accountId", patch.accountId);
      state.workers.push(worker);
    }

    saveState();
    $("batchWorkersInput").value = "";
    renderWorkers();
  };

  $("workerList").onclick = (event) => {
    const delId = event.target.dataset.delete;
    if (delId) { state.workers = state.workers.filter(w => w.id !== delId); saveState(); renderWorkers(); return; }
    const copySub = event.target.dataset.copySub;
    if (copySub) { navigator.clipboard.writeText(copySub); event.target.textContent = "Copied!"; setTimeout(() => event.target.textContent = "Copy", 1500); return; }
    const rotateId = event.target.dataset.rotateSub;
    if (rotateId) {
      const worker = state.workers.find(w => w.id === rotateId);
      if (worker) rotateSubToken(worker);
      return;
    }
    const tokenId = event.target.dataset.setToken;
    if (tokenId) {
      const worker = state.workers.find(w => w.id === tokenId);
      if (worker) setSubToken(worker);
      return;
    }
    // Edit satu kartu (VPN maupun Load Balancer): form yang sama dengan "Tambah Worker", diisi
    // dari state worker itu. Jenisnya bisa diubah di sini, termasuk VPN <-> Load Balancer.
    const editWorker = event.target.dataset.editWorker;
    if (editWorker) {
      const worker = state.workers.find(w => w.id === editWorker);
      if (!worker) return;
      const form = $("addWorkerForm");
      $("workerName").value = worker.name;
      $("workerHost").value = worker.host;
      $("workerType").value = worker.type;
      $("workerUuid").value = worker.uuid || "";
      $("workerAccountId").value = worker.accountId || "";
      $("vpnDomainsField").hidden = worker.type !== "load_balancer";
      $("workerVpnDomains").value = (worker.vpn_domains || []).join(", ");
      form.hidden = false;
      form.dataset.editId = editWorker;
      form.querySelector("button[type=submit]").textContent = "Update Worker";
      form.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  $("workerList").onchange = (event) => {
    const id = event.target.dataset.toggle;
    if (id) { state.workers = state.workers.map(w => w.id === id ? { ...w, active: event.target.checked } : w); saveState(); renderWorkers(); }
  };
}

let _proxyPickerCache = null;
// Kapan snapshot `_proxyPickerCache` diambil (ms epoch). Dipakai baris statistik Generator untuk
// menyebut umur data: cache boleh sampai 6 jam, dan umur itu harus kelihatan, bukan tersembunyi.
let _proxyPickerAt = 0;

async function loadProxyPickerData() {
  if (_proxyPickerCache) return _proxyPickerCache;
  const CACHE_KEY = "proxyPickerCache";
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && cached.v === 3 && (Date.now() - cached.ts) < CACHE_TTL) {
      _proxyPickerCache = cached.data;
      _proxyPickerAt = cached.ts;
      return _proxyPickerCache;
    }
  } catch {}
  let proxies = [];
  if (supabase) {
    // `last_checked` dipakai untuk tahu baris mana yang masih segar (worker hanya memakai baris
    // < 6 jam). `tunnel_ok`/`tunnel_ms` diisi cron-worker dari probe tunnel di edge, sedangkan
    // `tunnel_host_ok`/`tunnel_host_ms` diisi panproxyscanner dari mesin scanner (vantage host).
    // Kolom bukti ditambahkan manual ke tabel, jadi proyeksi dicoba dari yang terlengkap ke yang
    // paling lama: PostgREST menolak kolom yang belum ada dan panel tetap jalan seperti dulu.
    const base = "ip,port,country,org,last_checked,ping";
    const projections = [
      base + ",tunnel_ok,tunnel_ms,tls_ok,tunnel_host_ok,tunnel_host_ms",
      base + ",tunnel_ok,tunnel_ms,tls_ok",
      base,
    ];
    let rows = null;
    for (const projection of projections) {
      const res = await supabase.from("proxy_pool").select(projection).eq("is_active", true);
      if (!res.error) { rows = res.data; break; }
    }
    if (rows && rows.length) {
      // Bentuk baris yang sama dipakai pemilih proxy (halaman Generator) dan ringkasan per negara
      // di halaman Proxy: proxyPoolRow.
      proxies = rows.map(proxyPoolRow);
    }
  }
  // No local fallback — only use Supabase
  if (!proxies.length) return [];
  proxies = proxies.map(p => ({ ...p, country: p.country || "??", org: p.org || "Unknown" }));
  _proxyPickerCache = proxies;
  _proxyPickerAt = Date.now();
  localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 3, data: proxies, ts: _proxyPickerAt }));
  return proxies;
}

// Bukti satu baris: `edge` = probe tunnel cron-worker Pan-VlessCloudflare (vantage edge, kolom `tunnel_ok`),
// `host` = verifikasi dari mesin scanner (kolom baru `tunnel_host_ok`, atau `tls_ok` versi lama).
// Baris yang di edge terbukti mati (`tunnel === false`) bukan bukti apa pun walau host bilang
// hidup: worker VLESS berjalan di edge, jadi vonis edge yang menentukan.
function proxyEvidence(p) {
  if (p.tunnel === true) return { kind: "edge", ms: Number(p.tunnelMs) || 0 };
  if (p.hostTunnel === true || p.tls === true) return { kind: "host", ms: Number(p.hostTunnelMs) || 0 };
  return { kind: "", ms: 0 };
}
function evidenceLabel(ev) { return ev.kind ? `✓ ${ev.kind}${ev.ms ? " " + ev.ms + " ms" : ""}` : ""; }

// Sehat = cron baru mengecek (< 6 jam, sama seperti filter pool di worker) dan tidak pernah
// dinyatakan mati oleh probe tunnel. `null` berarti belum pernah diprobe, bukan mati.
const PROXY_FRESH_MS = 6 * 60 * 60 * 1000;
function proxyHealth(list, countries) {
  const now = Date.now();
  const wanted = (countries || []).filter(Boolean);
  const scope = wanted.length ? list.filter((p) => wanted.includes(p.country)) : list;
  const fresh = scope.filter((p) => {
    const t = Date.parse(p.checked || "");
    return Number.isFinite(t) && (now - t) < PROXY_FRESH_MS;
  });
  // Baris yang di edge terbukti mati tidak pernah masuk daftar bukti maupun pilihan (selalu
  // kalah): mayoritas pool masih `tls_ok = true`, jadi `tls_ok`/`tunnel_host_ok` sendirian tidak
  // boleh membuat baris mati ikut ditawarkan.
  const usable = fresh.filter((p) => p.tunnel !== false);
  // Tingkat bukti dari kuat ke lemah, saling lepas supaya hitungannya tidak dobel:
  // edge (tunnel nyata dari edge) → host (tunnel nyata dari mesin scanner) → segar tanpa bukti.
  const edge = usable.filter((p) => p.tunnel === true);
  const host = usable.filter((p) => p.tunnel !== true && (p.hostTunnel === true || p.tls === true));
  const unproven = usable.filter((p) => p.tunnel !== true && !(p.hostTunnel === true || p.tls === true));
  const verifiedList = edge.concat(host);
  // Urutan pilihan: tingkat bukti dulu (edge → host), lalu kecepatan di dalam tingkat itu.
  // Baris host tetap ditawarkan sesudah edge supaya pool tidak habis saat edge tipis, dan
  // hanya kalau dua-duanya kosong barulah baris segar yang belum diprobe (masih untung-untungan).
  // `tunnel === false` sudah dibuang di `usable`, jadi tidak pernah muncul di sini.
  const preferred = [...edge.slice().sort(proxySpeed), ...host.slice().sort(proxySpeed)];
  return {
    total: scope.length,
    fresh: fresh.length,
    edgeCount: edge.length,
    hostCount: host.length,
    unprovenCount: unproven.length,
    verifiedCount: verifiedList.length,
    knownDead: fresh.filter((p) => p.tunnel === false).length,
    usable: usable.slice().sort(proxySpeed),
    verified: verifiedList.slice().sort(proxySpeed),
    preferred: preferred.length ? preferred : unproven.slice().sort(proxySpeed),
  };
}

// Tercepat dulu: tunnel_ms (hasil tunnel nyata yang diukur cron) → ping cek ringan → sisanya
// di belakang. Urutan ini yang dipakai daftar proxy maupun mode rotasi.
function proxySpeed(a, b) {
  const speed = (p) => (p.tunnelMs > 0 ? p.tunnelMs : (p.ping > 0 ? p.ping + 1000 : 1e9));
  return speed(a) - speed(b);
}

function renderGenerator() {
  if (!$("generatorForm")) return;
  const workerSelect = $("workerSelect");
  const lbSelect = $("lbSelect");
  const modeSelect = $("modeSelect");
  const wanted = new URLSearchParams(location.search).get("worker");

  const vpnChoices = activeWorkers("vpn");

  workerSelect.innerHTML = `<option value="">Pilih VPN Worker</option>${vpnChoices.map(w => `<option value="${w.id}">${escapeHtml(w.name)} · ${escapeHtml(w.host)}</option>`).join("")}`;
  if (wanted && [...workerSelect.options].some(o => o.value === wanted)) workerSelect.value = wanted;

  const lbWorkers = activeWorkers("load_balancer");
  lbSelect.innerHTML = `<option value="">Pilih Load Balancer</option>${lbWorkers.map(w => `<option value="${w.id}">${escapeHtml(w.name)} · ${escapeHtml(w.host)}</option>`).join("")}`;

  let allProxies = [];
  const countrySelect = $("countrySelect");
  const countryList = $("countryList");
  const orgSelect = $("orgSelect");
  const proxySelect = $("proxySelect");

  // Satu negara per pilihan; kolomnya bisa DIKETIK (kode, label, atau nama Indonesia) dengan saran
  // dari <datalist>. Kosong = semua negara; nilai tak dikenali TIDAK diam-diam jadi "semua" — aksi
  // (pratinjau/buat config) menampilkannya sebagai pesan dan menolak membuat config.
  const countryCodes = () => countryOptionList(allProxies.map(p => p.country));
  const countryTyped = () => countrySelect.value.trim();
  const countryUnknown = () => Boolean(countryTyped()) && !resolveCountry(countryTyped(), countryCodes());
  const countryHint = () => countryUnknown() ? `Negara "${countryTyped()}" tidak dikenali. Kosongkan untuk semua negara.` : "";
  const selectedCountries = () => { const cc = resolveCountry(countrySelect.value, countryCodes()); return cc ? [cc] : []; };
  const populateCountries = () => {
    // ISO lengkap + kode dari pool: filter tetap bisa dipilih walau negaranya belum punya proxy segar.
    const keep = countrySelect.value || "";
    // Negara yang punya proxy segar tampil di atas (jumlah terbanyak dulu); sisanya tetap terdaftar
    // tapi ada di bawah, jadi daftar ISO tidak menutupi negara yang benar-benar bisa dipakai.
    const options = countryOptionList(allProxies.map(p => p.country))
      .map(c => ({ code: c, fresh: proxyHealth(allProxies, [c]).fresh }))
      .sort((x, y) => (y.fresh - x.fresh) || x.code.localeCompare(y.code));
    countryList.innerHTML = options.map(o =>
      `<option value="${o.code}">${getFlagEmoji(o.code)} ${o.code} · ${o.fresh} segar</option>`
    ).join("");
    countrySelect.value = keep;
  };
  // Rincian asal bukti untuk ringkasan: edge (probe tunnel cron-worker Pan-VlessCloudflare) vs host (verifikasi
  // panproxyscanner dari mesin scanner). Tingkatnya saling lepas, jadi edge + host = terverifikasi.
  const evidenceBreakdown = (h) => {
    const parts = [];
    if (h.edgeCount) parts.push(`${h.edgeCount} terbukti edge`);
    if (h.hostCount) parts.push(`${h.hostCount} terbukti host`);
    if (h.unprovenCount) parts.push(`${h.unprovenCount} belum diprobe`);
    return parts;
  };
  const updateCountryStats = () => {
    const el = $("countryStats");
    if (!el) return;
    // Nilai tak dikenali ditampilkan apa adanya, bukan diam-diam dianggap "semua negara".
    if (countryUnknown()) {
      el.textContent = countryHint();
      el.classList.add("error");
      return;
    }
    const cc = selectedCountries();
    // Umur snapshot pool (kapan data ini ditarik). Cache boleh berumur sampai 6 jam, jadi umur ini
    // yang membuat pemilik panel tahu angka di bawah berasal dari data tua dan perlu "Muat ulang pool".
    const poolAge = () => (_proxyPickerAt ? " · data pool " + poolAgeLabel(_proxyPickerAt, Date.now()) : "");
    if (!cc.length) {
      const all = proxyHealth(allProxies, []);
      const sources = evidenceBreakdown(all);
      el.textContent = `${all.fresh} proxy segar di semua negara (${all.usable.length} siap dipakai).`
        + (sources.length ? " " + sources.join(" · ") + "." : "")
        + poolAge();
      el.classList.remove("error");
      return;
    }
    const h = proxyHealth(allProxies, cc);
    const shown = cc.slice(0, 3).map(c => `${getFlagEmoji(c)} ${c}`);
    const flag = shown.join(" + ") + (cc.length > shown.length ? ` + ${cc.length - shown.length}` : "");
    const parts = [`${flag}: ${h.fresh} dari ${h.total} proxy masih segar`];
    if (h.verifiedCount) parts.push(h.verifiedCount + " terverifikasi tunnel");
    else if (h.knownDead) parts.push(`${h.knownDead} terbukti mati`);
    else parts.push("belum ada yang terverifikasi tunnel");
    // Bagian baru (kalimat lama di atas tidak diubah): dari vantage mana buktinya, dan berapa yang
    // justru dinyatakan mati oleh edge walau host masih bilang hidup.
    const sources = evidenceBreakdown(h);
    if (sources.length) parts.push(sources.join(" · "));
    if (h.knownDead && h.verifiedCount) parts.push(`${h.knownDead} terbukti mati di edge`);
    let text = parts.join(" · ");
    // Kalimat penutup pendek: sebabnya + satu saran. Tiga kasus dibedakan supaya tidak menuduh
    // ">6 jam" pada negara yang memang belum punya baris sama sekali.
    if (!h.usable.length) {
      if (!h.total) text += " — belum ada proxy negara ini di pool, pakai /ALL atau negara lain.";
      else text += h.fresh ? " — tidak ada yang siap pakai, pakai /ALL atau negara lain." : " — semua >6 jam, pakai /ALL atau negara lain.";
    }
    if (h.verified.length) text += " · tercepat " + (proxyEvidence(h.verified[0]).ms || h.verified[0].ping) + " ms";
    el.textContent = text + poolAge();
    el.classList.toggle("error", h.usable.length === 0);
  };
  const populateOrgs = () => {
    const cc = selectedCountries();
    const scope = cc.length ? allProxies.filter(p => cc.includes(p.country)) : allProxies;
    const orgs = [...new Set(scope.map(p => p.org))].sort();
    orgSelect.innerHTML = `<option value="">Semua penyedia</option>` + orgs.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  };
  const populateProxies = () => {
    const cc = selectedCountries();
    const org = orgSelect.value;
    const usable = proxyHealth(allProxies, cc).preferred;
    const filtered = org ? usable.filter(p => p.org === org) : usable;
    proxySelect.innerHTML = `<option value="">Acak (${filtered.length} proxy siap pakai)</option>` + filtered.slice(0, 200).map(p => {
      // Tanda bukti menyebut sumbernya (edge/host) supaya kelihatan baris ini lolos dari vantage
      // mana; baris tanpa bukti tidak diberi tanda.
      const proof = evidenceLabel(proxyEvidence(p));
      return `<option value="${p.ip}:${p.port}">${getFlagEmoji(p.country)} ${p.ip}:${p.port} · ${escapeHtml(p.org)}${proof ? " · " + proof : ""}</option>`;
    }).join("");
  };

  // Muat daftar pool. `fresh` = tombol "Muat ulang pool" ditekan: cache (localStorage + memori)
  // dibuang dulu supaya baris yang baru dicabut dari pool tidak tertinggal sampai TTL 6 jam.
  // Tanpa `fresh` (muat pertama) cache dipakai apa adanya — umurnya memang ditampilkan di baris
  // statistik, jadi data tua tidak lagi tersembunyi. `_proxyPickerCache` WAJIB dikosongkan saat
  // `fresh`: tanpa itu loadProxyPickerData() mengembalikan array lama tanpa menyentuh Supabase.
  const reloadPoolBtn = $("reloadPool");
  const loadPool = async (fresh) => {
    if (reloadPoolBtn && reloadPoolBtn.disabled) return;
    if (reloadPoolBtn) { reloadPoolBtn.disabled = true; reloadPoolBtn.textContent = "Memuat..."; }
    try {
      if (fresh) {
        localStorage.removeItem("proxyPickerCache");
        localStorage.removeItem("proxyListCache");
        localStorage.removeItem("proxyActiveCountCache");
        _proxyPickerCache = null;
      }
      setMessage("formMessage", "Memuat daftar proxy...");
      allProxies = await loadProxyPickerData();
      populateCountries();
      populateOrgs();
      populateProxies();
      updateCountryStats();
      updatePreview();
      setMessage("formMessage", `${allProxies.length} proxy aktif tersedia.`);
    } catch (e) {
      setMessage("formMessage", "Gagal memuat proxy: " + e.message, true);
    } finally {
      if (reloadPoolBtn) { reloadPoolBtn.disabled = false; reloadPoolBtn.textContent = "Muat ulang pool"; }
    }
  };
  if (reloadPoolBtn) reloadPoolBtn.onclick = () => loadPool(true);

  loadPool(false);

  const selectedWorker = () => state.workers.find(w => w.id === workerSelect.value && w.type === "vpn");
  const selectedLb = () => state.workers.find(w => w.id === lbSelect.value && w.type === "load_balancer");

  modeSelect.onchange = () => {
    const isSub = modeSelect.value === "subscription";
    $("localMode").hidden = isSub;
    $("subMode").hidden = !isSub;
    updatePreview();
  };

  // Kolom bisa diketik: `input` bereaksi tiap ketukan, `change` menangkap pilihan dari saran datalist.
  const countryChanged = () => { populateOrgs(); populateProxies(); updateCountryStats(); updatePreview(); };
  countrySelect.oninput = countrySelect.onchange = countryChanged;
  $("rotateSelect").onchange = () => updatePreview();
  orgSelect.onchange = () => { populateProxies(); updatePreview(); };
  proxySelect.onchange = () => updatePreview();
  lbSelect.onchange = () => updatePreview();

  // URL langganan dari hasil generate terakhir (dipakai tombol QR). Dikosongkan di mode local
  // supaya QR tidak menawarkan URL basi dari mode subscription sebelumnya.
  let lastSubUrl = "";

  const buildSubUrl = () => {
    const lb = selectedLb();
    if (!lb) return "";
    const lim = $("subLimitInput").value || 20;
    const fmt = $("subFormatSelect").value;
    const cc = $("subCcInput").value.trim();
    const domains = lb.vpn_domains || [];
    let url = `https://${lb.host}/api/v1/sub?format=${fmt}&limit=${lim}`;
    if (cc) url += `&cc=${cc.toUpperCase()}`;
    if (domains.length) url += `&domains=${domains.join(",")}`;
    url += `&insecure=1`;
    const subUuid = subUrlUuid(domains, state.workers);
    if (subUuid) url += `&uuid=${subUuid}`;
    return withSubToken(url, lb.sub_token);
  };

  const updatePreview = () => {
    const isSub = modeSelect.value === "subscription";
    if (isSub) {
      const lb = selectedLb();
      if (!lb) { $("urlPreview").textContent = "Pilih Load Balancer dulu."; return; }
      $("urlPreview").textContent = `Subscription: ${lb.host} · ${$("subLimitInput").value} config`;
    } else {
      $("subUrlPreview").hidden = true;
      const worker = selectedWorker();
      if (!worker) { $("urlPreview").textContent = "Pilih VPN Worker aktif dulu."; return; }
      const cc = selectedCountries();
      const mode = $("rotateSelect").value;
      const org = orgSelect.value;
      const specific = proxySelect.value;
      const lim = $("limitInput").value;
      const plan = rotationPlan(mode, cc);
      let info = `${worker.host} · ${lim} config`;
      if (plan.rotate) {
        // Filter negara tidak menyaring apa pun di mode rotasi: worker yang memilih proxy.
        info += plan.path ? ` · rotasi · ${plan.path}` : " · rotasi · pilih negara dulu";
        if (mode === "all" && cc.length) info += " · filter negara tidak dipakai";
      } else if (specific) {
        info += ` · proxy spesifik · ${specific}`;
      } else if (cc.length) {
        info += ` · acak ${cc.map(c => `${getFlagEmoji(c)} ${c}`).join("+")}`;
      } else {
        info += ` · acak semua negara`;
      }
      if (!plan.rotate && org) info += ` · ${org}`;
      // Nilai tak dikenali terlihat di pratinjau juga (mode /ALL memang tidak memakai filter negara).
      if (mode !== "all" && countryUnknown()) info += " · ⚠ " + countryHint();
      if (!worker.uuid) info += " · ⚠ UUID belum terikat (deploy ulang dari panel)";
      $("urlPreview").textContent = info;
    }
  };

  ["workerSelect", "vpnSelect", "portSelect", "formatSelect", "limitInput", "subFormatSelect", "subLimitInput", "subCcInput"].forEach(id => $(id).addEventListener("input", updatePreview));
  updatePreview();

  $("generatorForm").onsubmit = async (event) => {
    event.preventDefault();
    const isSub = modeSelect.value === "subscription";
    $("generateButton").disabled = true;
    try {
      if (isSub) {
        const lb = selectedLb();
        if (!lb) return setMessage("formMessage", "Pilih Load Balancer dulu.", true);
        const url = buildSubUrl();
        lastSubUrl = url;
        setMessage("formMessage", "Mengambil config dari Load Balancer...");
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) throw new Error(`Load Balancer merespons ${res.status}`);
          const content = await res.text();
          if (!content || content.length < 10) throw new Error("Load Balancer tidak mengembalikan config.");
          $("resultText").value = content;
          const count = $("subFormatSelect").value === "raw" ? content.split("\n").filter(Boolean).length : 1;
          $("countBadge").textContent = `${count} config`;
        } catch (fetchErr) {
          // CORS atau network error: tetap tampilkan URL supaya user bisa pakai manual
          $("resultText").value = `Gagal fetch otomatis (${fetchErr.message}).\n\nSalin URL subscription di bawah dan buka di browser atau tempel ke app VPN client.\n\nURL:\n${url}`;
          $("countBadge").textContent = "0 config";
          setMessage("formMessage", "Fetch gagal. URL tetap dibuat — salin dan pakai manual.", true);
        }
        // Tampilkan URL subscription di area hasil
        const subPreview = $("subUrlPreview");
        if (subPreview) {
          $("subUrlCode").textContent = url;
          subPreview.hidden = false;
        }
        $("copyButton").disabled = false;
        $("downloadButton").disabled = false;
        state.generatedCount += 1;
        saveState();
      } else {
        // Mode local tidak punya URL langganan: QR hanya menawarkan config.
        lastSubUrl = "";
        const worker = selectedWorker();
        if (!worker) return setMessage("formMessage", "Pilih VPN Worker aktif dulu.", true);
        // Worker yang di-deploy panel mengunci UUID lewat binding UUID_ALLOWLIST. Kalau state
        // tidak menyimpan UUID-nya (worker lama / ditambah manual), config hasil generate akan
        // membawa UUID acak yang pasti ditolak worker — lebih baik ditolak di sini dengan pesan
        // jelas daripada user bingung kenapa "tersambung lalu putus".
        if (!worker.uuid) {
          return setMessage("formMessage", "Worker ini belum punya UUID terikat. Deploy ulang worker dari halaman Deploy supaya UUID-nya tercatat, lalu generate lagi (atau pakai config lama yang masih memakai UUID tersebut).", true);
        }
        // Kolom filter bisa diketik: nilai tak dikenali ditolak di sini dengan pesan jelas, bukan
        // diam-diam dijadikan "semua negara" (config-nya beda dari yang diminta pengguna).
        if ($("rotateSelect").value !== "all" && countryUnknown()) {
          return setMessage("formMessage", countryHint(), true);
        }
        // Mode rotasi "negara terpilih" tanpa negara = config salah (path kosong), jadi ditolak di
        // sini dengan pesan jelas; tombol tetap boleh ditekan, hasilnya tidak berubah.
        const plan = rotationPlan($("rotateSelect").value, selectedCountries());
        if (plan.rotate && !plan.path) {
          return setMessage("formMessage", "Pilih negara dulu untuk mode ini (Rotasi · negara terpilih).", true);
        }
        const ccList = plan.ccList;
        const orgValue = orgSelect.value;
        const rotate = plan.rotate;
        const specificProxy = proxySelect.value;
        let customProxyList = [];
        if (!rotate) {
          if (specificProxy) {
            customProxyList = [specificProxy];
          } else {
            // Hanya baris segar (< 6 jam) dan yang belum dinyatakan mati oleh probe tunnel;
            // proxy basi berarti config yang tidak akan tersambung.
            const usable = proxyHealth(allProxies, ccList).preferred;
            customProxyList = (orgValue ? usable.filter(p => p.org === orgValue) : usable).map(p => p.ip + ":" + p.port);
          }
          if (!customProxyList.length) throw new Error("Tidak ada proxy segar untuk filter ini.");
        }
        const params = {
          host: worker.host,
          serviceName: worker.host.split(".")[0],
          vpnList: [$("vpnSelect").value],
          portList: [$("portSelect").value],
          format: $("formatSelect").value,
          limit: Number($("limitInput").value),
          ccList,
          customProxyList,
          rotate,
          // Selalu allowInsecure untuk TLS: klien di perangkat lama menolak rantai sertifikat Cloudflare.
          insecure: true,
        };
        const content = await generateLocalConfigs(params);
        $("resultText").value = content;
        const count = params.format === "raw" ? content.split("\n").filter(Boolean).length : 1;
        $("countBadge").textContent = `${count} config`;
      }
      $("copyButton").disabled = false;
      $("downloadButton").disabled = false;
      if ($("qrButton")) $("qrButton").disabled = false;
      state.generatedCount += 1;
      saveState();
      setMessage("formMessage", "Config berhasil dibuat.");
      // Panel QR yang sedang terbuka ikut disegarkan supaya isinya cocok dengan hasil terbaru.
      if ($("qrPanel") && !$("qrPanel").hidden) await renderQrPanel();
    } catch (error) {
      setMessage("formMessage", error.message, true);
    } finally {
      $("generateButton").disabled = false;
    }
  };

  $("copyButton").onclick = async () => { await navigator.clipboard.writeText($("resultText").value); setMessage("formMessage", "Config disalin."); };
  $("downloadButton").onclick = () => { const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([$("resultText").value])), download: "pan-vlesscloudflare-config.txt" }); link.click(); URL.revokeObjectURL(link.href); };

  // ---- Panel QR -----------------------------------------------------------------------------
  // Dua sumber QR: config (URI vless:// — termasuk config mode rotasi /ALL dan /ID,SG, karena itu
  // config yang sama) dan URL langganan bertoken. Keduanya digambar di browser oleh frontend/qr.js
  // memakai lib vendor, jadi isi QR tidak pernah keluar dari perangkat user.
  const renderQrPanel = async () => {
    const targets = $("qrTargets");
    if (!targets) return;
    const sources = qrTargets($("resultText").value, lastSubUrl);
    targets.replaceChildren();
    if (!sources.length) {
      setMessage("qrMessage", "Tidak ada config vless:// atau URL langganan untuk dibuat QR. Buat config dengan format Raw dulu.", true);
      return;
    }
    setMessage("qrMessage", "Membuat QR...");
    for (const source of sources) {
      const figure = document.createElement("figure");
      figure.className = "qr-item";
      figure.dataset.qrKind = source.kind;
      const slot = document.createElement("div");
      slot.className = "qr-slot";
      const caption = document.createElement("figcaption");
      caption.textContent = source.label;
      const payload = document.createElement("code");
      payload.className = "qr-payload";
      payload.textContent = source.text.length > 72 ? `${source.text.slice(0, 69)}…` : source.text;
      figure.append(slot, caption, payload);
      targets.append(figure);
      try {
        await renderQrInto(slot, source.text, { alt: `QR ${source.label}` });
      } catch (error) {
        // Lib vendor gagal dimuat / tidak mengembalikan gambar: pesannya ditulis di tempat QR-nya,
        // bukan menghilang ke console.
        slot.textContent = error.message;
      }
    }
    setMessage("qrMessage", "");
  };

  const qrButton = $("qrButton");
  if (qrButton) {
    qrButton.onclick = async () => {
      const panel = $("qrPanel");
      if (!panel) return;
      panel.hidden = !panel.hidden;
      if (!panel.hidden) await renderQrPanel();
    };
  }

  const copySubBtn = $("copySubUrlBtn");
  if (copySubBtn) {
    copySubBtn.onclick = async () => {
      await navigator.clipboard.writeText($("subUrlCode").textContent);
      copySubBtn.textContent = "Copied!";
      setTimeout(() => copySubBtn.textContent = "Copy", 1500);
    };
  }
  const openSubBtn = $("openSubUrlBtn");
  if (openSubBtn) {
    openSubBtn.onclick = () => {
      const url = $("subUrlCode").textContent;
      if (url) window.open(url, "_blank");
    };
  }
}
// ---- Riwayat deploy: penulisan best-effort ------------------------------------------------
// Panel menulis SATU baris audit per deploy sukses (lihat sql/2026-11-15-deploy-log.sql).
// Kegagalan menulis TIDAK boleh mengubah hasil deploy yang sudah berhasil, jadi fungsinya selalu
// mengembalikan boolean dan tidak pernah melempar: RPC/tabel yang belum ada adalah keadaan yang
// diharapkan (migrasi dijalankan manusia) dan cuma jadi catatan di dashboard.
// Insert TANPA `.select()` setelahnya itu penting: anon memang tidak diberi hak SELECT pada
// deploy_log (riwayatnya bersifat lintas akun), dan PostgREST hanya menuntut hak itu kalau panel
// meminta baris balikannya. Pembacaan riwayat lewat RPC ber-hash (renderDeployLog).
async function writeDeployLog(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!supabase || !list.length) return false;
  try {
    const { error } = await supabase.from(DEPLOY_LOG_TABLE).insert(list);
    if (!error) return true;
    if (!deployLogMissing(error)) console.warn("catatan deploy gagal ditulis:", rpcErrorMessage(error));
    return false;
  } catch (error) {
    console.warn("catatan deploy gagal ditulis:", rpcErrorMessage(error));
    return false;
  }
}

function renderDeploy() {
  if (!$("deployForm")) return;
  $("cancelDeploy").onclick = () => { location.href = "workers.html"; };

  // Tidak ada pilihan tier (Free/Premium): satu template worker VPN dipakai semua user.
  const typeSelect = $("deployType");

  // UUID worker: tombol pembuat + prefill dari query (dipakai tautan "deploy ulang" dari
  // halaman Workers) supaya redeploy memakai UUID yang sama dengan konfigurasi klien lama.
  const uuidInput = $("deployUuid");
  if (uuidInput) {
    const query = new URLSearchParams(location.search);
    if (!uuidInput.value) uuidInput.value = query.get("uuid") || "";
    const genBtn = $("genUuidBtn");
    if (genBtn) genBtn.onclick = () => { uuidInput.value = crypto.randomUUID(); };
  }
  const nameInput = $("deployName");
  if (nameInput) {
    const query = new URLSearchParams(location.search);
    const nameParam = query.get("name");
    if (nameParam) nameInput.value = nameParam.toLowerCase();
    const typeParam = query.get("type");
    if (typeParam && typeSelect) {
      typeSelect.value = typeParam;
      typeSelect.dispatchEvent(new Event("change"));
    }
  }

  // ---- Deploy ulang semua worker tersimpan ------------------------------------------------
  // /api/cf membatasi 10 permintaan per IP per 10 menit, jadi batch ini berjalan SEKUENTIAL dan
  // berhenti begitu route menjawab 429 (lihat pemakaian rateLimitInfo di bawah).
  let deployBusy = false;   // deploy tunggal (form di atas) sedang berjalan
  let redeployBusy = false; // batch sedang berjalan
  const redeployBtn = $("redeployAllBtn");
  const redeployCountEl = $("redeployCount");

  // Kredensial memang tidak disimpan di localStorage, jadi tombol batch hanya hidup selama
  // form di atas terisi lengkap.
  const credentialsReady = () => {
    const key = $("cfApiKey")?.value.trim() || "";
    const mail = $("cfEmail")?.value.trim() || "";
    return Boolean(key && (!cfSecretNeedsEmail(key) || mail) && $("cfAccountId")?.value.trim());
  };

  const refreshRedeployButton = () => {
    if (redeployCountEl) redeployCountEl.textContent = String(state.workers.length);
    if (!redeployBtn) return;
    const count = state.workers.length;
    const busy = deployBusy || redeployBusy;
    redeployBtn.disabled = busy || count === 0 || !credentialsReady();
    redeployBtn.title = count === 0
      ? "Belum ada worker tersimpan."
      : !credentialsReady()
        ? "Isi Email, API Key, dan Account ID Cloudflare dulu."
        : busy
          ? "Sedang mengirim permintaan deploy..."
          : `Kirim ulang template terbaru ke ${count} worker, satu per satu.`;
  };

  ["cfApiKey", "cfEmail", "cfAccountId"].forEach((id) => {
    $(id)?.addEventListener("input", refreshRedeployButton);
  });
  refreshRedeployButton();

  $("deployForm").onsubmit = async (event) => { 
    event.preventDefault(); 
    const type = $("deployType").value; 
    const name = $("deployName").value.trim().toLowerCase();
    
    const cfApiKey = $("cfApiKey").value.trim();
    const cfEmail = $("cfEmail").value.trim();
    const accountId = $("cfAccountId").value.trim();

    // UUID opsional: kalau diisi, worker dikunci ke UUID ini (binding UUID_ALLOWLIST).
    const uuidValue = ($("deployUuid")?.value || "").trim();
    if (uuidValue && !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(uuidValue)) {
      setMessage("deployMessage", "UUID tidak valid (format 8-4-4-4-12 heksadesimal).", true);
      return;
    }

    $("startDeployBtn").disabled = true;
    deployBusy = true;
    refreshRedeployButton();
    setMessage("deployMessage", "Mengambil source code worker...");

    // Token langganan LB: worker LB tersimpan dengan nama script yang sama dipakai ulang tokennya
    // supaya tautan langganan yang sudah dibagikan tetap valid (lihat ensureSubToken); worker yang
    // belum punya token dibuatkan sekali di sini dan ikut `save_state`. Jalur VPN tidak pernah
    // mengirim SUB_TOKEN — template VPN tidak membacanya.
    const existingLb = type === "load_balancer"
      ? state.workers.find((w) => w.type === "load_balancer" && String(w.name || "").trim().toLowerCase() === name)
      : null;
    const subToken = type === "load_balancer" ? ensureSubToken(existingLb) : "";
    const vars = uuidValue ? { UUID_ALLOWLIST: uuidValue } : {};
    if (subToken) vars.SUB_TOKEN = subToken;

    try {
      // Ambil file dari dalam repo kita sendiri (di folder source). Worker VPN selalu memakai
      // satu template (panvlesscloudflare.js) — tidak ada lagi pilihan tier.
      const sourceUrl = type === "load_balancer"
        ? "/source/load-balancer.js"
        : "/source/panvlesscloudflare.js";
        
      const codeRes = await fetch(sourceUrl);
      if (!codeRes.ok) throw new Error("Gagal mengambil source code worker dari server");
      const code = await codeRes.text();

      setMessage("deployMessage", "Mengirim instruksi deploy ke Cloudflare API...");

      const deployRes = await fetch("/api/cf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cfEmail,
          cfApiKey,
          accountId,
          scriptName: name,
          code,
          type,
          vars,
        })
      });

      const deployData = await deployRes.json();
      
      if (!deployRes.ok || !deployData.success) {
        throw new Error(deployData.error || "Deploy gagal: " + JSON.stringify(deployData.details));
      }

      const envNote = Array.isArray(deployData.env) && deployData.env.length
        ? ` · env terpasang: ${deployData.env.join(", ")}`
        : "";
      setMessage("deployMessage", "Deploy sukses! Menyimpan worker ke dashboard..." + envNote);

      // Pakai host dari API response (sudah include subdomain asli)
      const finalHost = deployData.host || `${name}.workers.dev`;

      if (existingLb) {
        // LB dengan scriptName yang sama sudah tersimpan: kartu itu yang diperbarui (host + token
        // yang sama), bukan ditambah kartu duplikat yang URL langganannya beda token.
        existingLb.host = finalHost;
        existingLb.sub_token = subToken;
        existingLb.accountId = accountId; // akun pemilik worker: dasar gate kuota per akun
        if (uuidValue) existingLb.uuid = uuidValue;
      } else {
        const worker = {
          id: crypto.randomUUID(),
          name: name,
          host: finalHost,
          type,
          active: true,
          source: "cloudflare-auto",
          uuid: uuidValue || undefined,
          // Account ID disimpan supaya pemakaian beberapa worker dalam satu akun bisa
          // dijumlahkan di panel kuota (gate 90%). Tidak pernah dikirim sebagai env worker.
          accountId: accountId,
        };
        if (subToken) worker.sub_token = subToken;
        state.workers.push(worker);
      }

      await saveState();
      // Audit: satu baris per deploy sukses. Best-effort — tabel deploy_log baru ada setelah
      // sql/2026-11-15-deploy-log.sql dijalankan, dan deploy yang sudah sukses tidak boleh
      // tampak gagal hanya karena catatannya tidak bisa ditulis.
      await writeDeployLog(deployLogRow({ username: currentUser?.username, name, type, host: finalHost, action: "deploy" }));
      setMessage("deployMessage", `Deploy sukses! Worker: ${finalHost}`);
      setTimeout(() => location.href = "workers.html", 1500);

    } catch (error) {
      setMessage("deployMessage", error.message, true);
      $("startDeployBtn").disabled = false;
      deployBusy = false;
      refreshRedeployButton();
    }
  };

  // Batch: satu permintaan pada satu waktu, berhenti saat kena rate limit.
  if (redeployBtn) redeployBtn.onclick = async () => {
    const steps = redeployPlan(state.workers);
    if (!steps.length) return setMessage("redeployMessage", "Belum ada worker tersimpan.", true);

    const cfApiKey = $("cfApiKey").value.trim();
    const cfEmail = $("cfEmail").value.trim();
    const accountId = $("cfAccountId").value.trim();
    if (!cfApiKey || (cfSecretNeedsEmail(cfApiKey) && !cfEmail) || !accountId) {
      return setMessage("redeployMessage", "Isi Email, API Key, dan Account ID Cloudflare dulu.", true);
    }
    if (!window.confirm(`Deploy ulang ${steps.length} worker tersimpan, satu per satu?`)) return;

    redeployBusy = true;
    refreshRedeployButton();
    setMessage("redeployMessage", `${steps.length} worker tersimpan akan di-deploy ulang satu per satu...`);

    const results = [];
    const templates = new Map(); // template -> source, diambil sekali per jenis worker
    try {
      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i];
        setMessage("redeployMessage", redeployProgressLine(i + 1, steps.length, step.name, null));

        let result;
        try {
          if (!templates.has(step.template)) {
            const sourceRes = await fetch(step.template);
            if (!sourceRes.ok) throw new Error(`Gagal mengambil template ${step.template}`);
            templates.set(step.template, await sourceRes.text());
          }

          const deployRes = await fetch("/api/cf", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              cfEmail,
              cfApiKey,
              accountId,
              scriptName: step.name,
              code: templates.get(step.template),
              type: step.type,
              vars: step.vars,
            }),
          });

          const deployData = await deployRes.json().catch(() => null);
          const limit = rateLimitInfo(deployRes.status, deployRes.headers.get("Retry-After"), deployData);
          if (limit.limited) {
            // Jendela rate limit per IP habis: sisa worker TIDAK dikirim sama sekali dan loop
            // berhenti setelah baris ini ditulis (tanpa ulang otomatis); ringkasan akhir
            // menyebut limitnya beserta Retry-After.
            result = {
              name: step.name,
              ok: false,
              limited: true,
              retryAfter: limit.retryAfter,
              error: (deployData && deployData.error) || "Terlalu banyak permintaan.",
            };
          } else {
            if (!deployRes.ok || !(deployData && deployData.success)) {
              throw new Error((deployData && deployData.error) || `Deploy gagal (HTTP ${deployRes.status})`);
            }
            result = { name: step.name, ok: true };
          }
        } catch (error) {
          result = { name: step.name, ok: false, error: error.message || "gagal" };
        }

        results.push(result);
        setMessage("redeployMessage", redeployProgressLine(i + 1, steps.length, step.name, result));
        if (result.limited) break;
        // Beri browser satu giliran untuk menggambar baris hasil di atas: tanpa jeda ini baris
        // hasil worker tertimpa baris "mengirim template..." worker berikutnya di task yang sama
        // dan tidak pernah terlihat.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      // Worker yang sukses baru saja dipasang ke akun yang Account ID-nya dipakai batch ini, jadi
      // Account ID itu disimpan ke entri state-nya: agregasi kuota per akun tidak perlu menebak
      // lewat fallback "satu akun" untuk worker yang sudah jelas akunnya.
      const deployedNames = new Set(results.filter((result) => result.ok).map((result) => result.name));
      for (const worker of state.workers) {
        if (deployedNames.has(String(worker.name || "").trim())) worker.accountId = accountId;
      }

      // Worker yang sukses sudah ada di state (redeploy tidak menambah entri baru), jadi state
      // disimpan SEKALI di akhir, bukan sekali per worker.
      await saveState();
      // Audit batch: satu baris per worker yang SUKSES (action "redeploy-all"). Host/type diambil
      // dari state karena balasan /api/cf hanya memberi nama script.
      const byName = new Map(state.workers.map((worker) => [String(worker.name || "").trim(), worker]));
      await writeDeployLog(
        deployLogRows(
          currentUser?.username,
          "redeploy-all",
          results.filter((result) => result.ok).map((result) => {
            const worker = byName.get(result.name);
            return { name: result.name, type: worker?.type, host: worker?.host };
          })
        )
      );
      const summary = summarizeRedeploy(results, steps.length);
      setMessage("redeployMessage", summary.message, summary.failed > 0 || summary.stopped);
      renderWorkers(); // daftar worker disegarkan kalau halaman ini menampilkannya
    } finally {
      redeployBusy = false;
      refreshRedeployButton();
    }
  };
}

async function hashPassword(password) { 
  const bytes = new TextEncoder().encode(password); 
  const hash = await crypto.subtle.digest("SHA-256", bytes); 
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, "0")).join(""); 
}

// Endpoint auth di Pages Function (/api/login, /api/register) membatasi percobaan per IP dan
// menaikkan batasnya jadi global lewat Supabase. Endpoint ini sekarang CADANGAN, bukan jalur
// pertama: kuota Functions dipakai bersama /api/cf, jadi login rutin tidak boleh membakar jatah
// deploy (lihat alasan lengkapnya di frontend/auth-flow.js). Dipakai hanya kalau RPC belum ada
// (PGRST202/42883/42P01), jaringan gagal, atau balasannya 503 (RPC belum siap di server).
async function postJson(url, payload, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs || 12000),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, ok: res.ok, data };
  } catch {
    return null;
  }
}

// ---- Auth lewat RPC: sql/2026-11-14-auth-hardening.sql -------------------------------
// Setelah SQL itu dijalankan, kolom password_hash tidak lagi bisa dibaca dengan anon key dan
// tidak ada izin tulis mentah ke users_custom, jadi login/daftar/aksi admin lewat fungsi
// SECURITY DEFINER. Semua jalur memakai fallback ke cara lama saat fungsinya belum ada, supaya
// panel tetap bekerja sebelum maupun sesudah SQL dijalankan. Deteksi "RPC belum ada"
// (rpcMissing/rpcErrorMessage), pesan kunci akun, dan seluruh urutan login/daftar tinggal di
// frontend/auth-flow.js supaya urutannya bisa diuji tanpa DOM (tests/login-flow.test.mjs).
function authDeps() {
  return { rpc: (name, args) => supabase.rpc(name, args), postJson };
}
// Sesi menyimpan hash sandi (bukan sandinya) karena aksi admin diverifikasi server dengan hash itu.
// Aksi admin diverifikasi server dengan hash sandi pelaku. Sesi lama (login sebelum SQL auth,
// atau sebelum login ulang) tidak membawa hash itu, jadi beri pesan yang jelas daripada error RPC
// mentah "Hanya admin yang boleh melakukan ini".
function adminActor() {
  if (!supabase) throw new Error("Supabase tidak terkoneksi.");
  if (!currentUser || !currentUser.hash) throw new Error("Sesi ini belum membawa verifikasi sandi — login ulang dulu.");
  return { p_actor: currentUser.username, p_actor_hash: currentUser.hash };
}

function saveSession(user, hash) {
  const session = { username: user.username, role: user.role || "user" };
  if (hash) session.hash = hash;
  localStorage.setItem(sessionKey, JSON.stringify(session));
  return session;
}

function renderAuth() {
  const tabLogin = $("tabLogin");
  const tabRegister = $("tabRegister");
  const paneLogin = $("paneLogin");
  const paneRegister = $("paneRegister");
  const loginMessage = $("loginMessage");
  const registerMessage = $("registerMessage");

  if (tabLogin && tabRegister) {
    const switchTab = (tab) => {
      const isLogin = tab === "login";
      tabLogin.classList.toggle("active", isLogin);
      tabLogin.setAttribute("aria-selected", String(isLogin));
      tabRegister.classList.toggle("active", !isLogin);
      tabRegister.setAttribute("aria-selected", String(!isLogin));
      paneLogin.hidden = !isLogin;
      paneRegister.hidden = isLogin;
      if (loginMessage) loginMessage.textContent = "";
      if (registerMessage) registerMessage.textContent = "";
    };
    tabLogin.onclick = () => switchTab("login");
    tabRegister.onclick = () => switchTab("register");
    if (location.hash === "#register") switchTab("register");
  }

  $("registerForm")?.addEventListener("submit", async (event) => { 
    event.preventDefault(); 
    const username = $("registerUsername").value.trim().toLowerCase();
    const password = $("registerPassword").value; 
    
    if (username.includes(" ")) return setMessage("registerMessage", "Username tidak boleh pakai spasi.", true);
    if (password !== $("registerConfirm").value) return setMessage("registerMessage", "Ulangi sandi harus sama.", true); 

    const passwordHash = await hashPassword(password);

    if (supabase) {
      // URUTAN BARU: RPC dulu, Function sebagai cadangan. Alasannya ada di frontend/auth-flow.js
      // (kuota Functions dipakai bersama /api/cf). Semua status yang membawa pesan ditampilkan apa
      // adanya; status "legacy" berarti RPC belum ada di server dan jalur lama di bawah dipakai.
      const outcome = await registerWithFallback({ username, password }, authDeps());
      if (outcome.status === "ok") {
        saveSession(outcome.user, passwordHash);
        location.href = "index.html";
        return;
      }
      if (outcome.status !== "legacy") {
        return setMessage("registerMessage", outcome.message || "Gagal buat akun.", true);
      }

      // Jalur lama (SQL auth/RPC belum dijalankan)
      const { data: existingUser, error: checkError } = await supabase.from('users_custom').select('username, role').eq('username', username).maybeSingle();
      if (checkError) return setMessage("registerMessage", "Error cek DB: " + checkError.message, true);
      if (existingUser) return setMessage("registerMessage", "Username sudah terdaftar.", true);
      const { error: insertError } = await supabase.from('users_custom').insert([{ username, password_hash: passwordHash }]).select("username, role");
      if (insertError) return setMessage("registerMessage", "Gagal buat akun: " + insertError.message, true);

      saveSession({ username, role: "user" }, passwordHash);
      location.href = "index.html";
      return;
    }

    // Fallback Lokal
    const allUsers = readJson(usersKey, []); 
    if (allUsers.some((user) => user.username === username)) return setMessage("registerMessage", "Username sudah dipakai.", true); 
    allUsers.push({ username, passwordHash, role: "user" }); 
    localStorage.setItem(usersKey, JSON.stringify(allUsers)); 
    localStorage.setItem(sessionKey, JSON.stringify({ username, role: "user" })); 
    location.href = "index.html"; 
  });

  $("loginForm")?.addEventListener("submit", async (event) => { 
    event.preventDefault(); 
    const username = $("loginUsername").value.trim().toLowerCase(); 
    const password = $("loginPassword").value;
    const passwordHash = await hashPassword(password);

    if (supabase) {
      // URUTAN BARU: RPC verify_login dulu (verifikasi sandi + kunci brute force per username),
      // /api/login hanya cadangan — lihat frontend/auth-flow.js. Akun yang sedang terkunci
      // (errcode 53400) tampil sebagai pesan kuncinya sendiri, bukan "sandi salah" dan bukan
      // "Error DB", dan sisa detiknya TIDAK dibuang ke jalur Function.
      const outcome = await loginWithFallback({ username, password }, authDeps());
      if (outcome.status === "ok") {
        saveSession(outcome.user, passwordHash);
        location.href = "index.html";
        return;
      }
      if (outcome.status === "locked") return setMessage("loginMessage", outcome.message, true);
      if (outcome.status === "invalid") return setMessage("loginMessage", "Username atau sandi salah.", true);
      if (outcome.status === "throttled") return setMessage("loginMessage", outcome.message, true);
      if (outcome.status === "bad-request") return setMessage("loginMessage", outcome.message, true);
      if (outcome.status === "error") return setMessage("loginMessage", outcome.message, true);

      // Jalur lama (SQL auth/RPC belum dijalankan)
      const { data: user, error } = await supabase.from('users_custom')
        .select('username, role')
        .eq('username', username)
        .eq('password_hash', passwordHash)
        .maybeSingle();
      if (error) return setMessage("loginMessage", "Error DB: " + error.message, true);
      if (!user) return setMessage("loginMessage", "Username atau sandi salah.", true);
      saveSession({ username: user.username, role: user.role || "user" }, passwordHash);
      location.href = "index.html";
      return;
    }

    // Fallback Lokal
    const user = readJson(usersKey, []).find((item) => item.username === username); 
    if (!user || user.passwordHash !== passwordHash) return setMessage("loginMessage", "Username atau sandi salah.", true); 
    localStorage.setItem(sessionKey, JSON.stringify({ username, role: user.role || "user" })); 
    location.href = "index.html"; 
  });
}

function readJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }


// Aksi admin "set_password"/"unlock" baru ada setelah sql/2026-11-21-admin-actions.sql: RPC yang
// belum dibuat membalas PGRST202, sedangkan fungsi versi lama membalas errcode 22023 "Aksi tidak
// dikenal: ...". Keduanya berarti migrasi, bukan sesi rusak — jadi pesannya menyebut migrasinya
// dan sesi tidak dihapus.
const ADMIN_MIGRATION_MESSAGE = "Migrasi admin-action belum dijalankan (sql/2026-11-21-admin-actions.sql): aksi ini belum ada di server.";
function adminActionMissing(error) {
  return rpcMissing(error) || /aksi tidak dikenal/i.test(rpcErrorMessage(error));
}

function renderAdmin() {
  if (!document.getElementById("addAdminForm")) return;

  let userFilter = "all";
  let allUserData = [];

  const loadStats = async () => {
    if (!supabase) return;
    try {
      const { count: total } = await supabase.from("users_custom").select("username", { count: "exact", head: true });
      document.getElementById("statTotalUsers").textContent = total ?? 0;
      const { count: admins } = await supabase.from("users_custom").select("username", { count: "exact", head: true }).eq("role", "admin");
      document.getElementById("statAdmins").textContent = admins ?? 0;
      const { count: regular } = await supabase.from("users_custom").select("username", { count: "exact", head: true }).eq("role", "user");
      document.getElementById("statRegularUsers").textContent = regular ?? 0;
    } catch {}
  };
  loadStats();

  const loadUsers = async () => {
    if (!supabase) return setMessage("userMessage", "Supabase tidak terkoneksi.", true);
    setMessage("userMessage", "Memuat...");
    try {
      const { data, error } = await supabase.from("users_custom").select("username, role");
      if (error) throw error;
      allUserData = data || [];
      let users = allUserData;
      if (userFilter === "admin") users = users.filter(u => u.role === "admin");
      const tbody = document.getElementById("userTableBody");
      tbody.innerHTML = users.map(u => {
        const isAdmin = u.role === "admin";
        const isSelf = u.username === currentUser?.username;
        const toggleBtn = isSelf ? '<span style="color:var(--muted);font-size:.75rem">Anda</span>' : `<button class="icon-button" data-toggle-role="${escapeHtml(u.username)}" data-current="${isAdmin ? "admin" : "user"}" type="button">${isAdmin ? "↓ User" : "↑ Admin"}</button>`;
        const delBtn = isSelf ? "" : `<button class="icon-button danger" data-delete-user="${escapeHtml(u.username)}" type="button" style="margin-left:4px">Hapus</button>`;
        // Reset sandi dan Buka kunci juga tampil untuk baris sendiri: server mengizinkan admin
        // mengganti sandinya sendiri, dan membuka kunci sendiri berguna kalau kuncinya baru saja
        // aktif. Keduanya lewat admin_action, jadi hanya admin yang bisa.
        const passBtn = `<button class="icon-button" data-reset-password="${escapeHtml(u.username)}" type="button" style="margin-left:4px">Reset sandi</button>`;
        const unlockBtn = `<button class="icon-button" data-unlock-user="${escapeHtml(u.username)}" type="button" style="margin-left:4px">Buka kunci</button>`;
        return `<tr><td><code>${escapeHtml(u.username)}</code></td><td>${isAdmin ? '<span class="proxy-status live">admin</span>' : '<span class="proxy-status dead">user</span>'}</td><td>${toggleBtn}${passBtn}${unlockBtn}${delBtn}</td></tr>`;
      }).join("");
      setMessage("userMessage", `${users.length} user.`);
    } catch (e) {
      setMessage("userMessage", "Error: " + e.message, true);
    }
  };
  loadUsers();

  document.getElementById("tabUsersBtn").onclick = () => { userFilter = "all"; updateUTabs(); loadUsers(); };
  document.getElementById("tabAdminsBtn").onclick = () => { userFilter = "admin"; updateUTabs(); loadUsers(); };
  const updateUTabs = () => {
    document.getElementById("tabUsersBtn").classList.toggle("active", userFilter === "all");
    document.getElementById("tabAdminsBtn").classList.toggle("active", userFilter === "admin");
  };

  // Toggle role
  document.getElementById("userTableBody").onclick = async (e) => {
    const toggleBtn = e.target.closest("[data-toggle-role]");
    if (toggleBtn) {
      const username = toggleBtn.dataset.toggleRole;
      const current = toggleBtn.dataset.current;
      const newRole = current === "admin" ? "user" : "admin";
      if (!confirm(`Ubah ${username} → ${newRole}?`)) return;
      toggleBtn.disabled = true;
      try {
        const viaRpc = await supabase.rpc("admin_action", {
          ...adminActor(),
          p_action: "set_role", p_target: username, p_role: newRole,
        });
        if (viaRpc.error) {
          if (!rpcMissing(viaRpc.error)) throw viaRpc.error;
          const { error } = await supabase.from("users_custom").update({ role: newRole }).eq("username", username);
          if (error) throw error;
        }
        setMessage("userMessage", `${username} → ${newRole}.`);
        loadUsers();
        loadStats();
      } catch (err) {
        setMessage("userMessage", "Gagal: " + err.message, true);
        toggleBtn.disabled = false;
      }
      return;
    }
    // Reset sandi: sandi baru TIDAK dikirim mentah — di-hash SHA-256 hex di browser (kolom
    // password_hash memang menyimpan bentuk itu) dan hash itulah yang diterima server.
    const passBtn = e.target.closest("[data-reset-password]");
    if (passBtn) {
      const username = passBtn.dataset.resetPassword;
      const password = window.prompt(`Sandi baru untuk ${username} (minimal 6 karakter):`);
      if (password === null) return;
      if (password.length < 6) return setMessage("userMessage", "Sandi minimal 6 karakter.", true);
      passBtn.disabled = true;
      try {
        const passwordHash = await hashPassword(password);
        const viaRpc = await supabase.rpc("admin_action", {
          ...adminActor(),
          p_action: "set_password", p_target: username, p_password: passwordHash,
        });
        if (viaRpc.error) {
          // PGRST202 (fungsi belum ada) maupun errcode 22023 "Aksi tidak dikenal" (fungsi versi
          // lama) sama-sama berarti migrasinya belum dijalankan. Sesi TIDAK dihapus: ini bukan
          // sesi yang rusak.
          if (!adminActionMissing(viaRpc.error)) throw viaRpc.error;
          throw new Error(ADMIN_MIGRATION_MESSAGE);
        }
        setMessage(
          "userMessage",
          viaRpc.data === false
            ? `${username} tidak ditemukan — tidak ada sandi yang diubah.`
            : `Sandi ${username} diperbarui.${username === currentUser?.username ? " Sesi ini masih memakai hash lama: login ulang setelah ini." : ""}`
        );
      } catch (err) {
        setMessage("userMessage", "Gagal: " + err.message, true);
      } finally {
        passBtn.disabled = false;
      }
      return;
    }

    // Buka kunci brute force: membersihkan baris login_attempts target (lihat
    // sql/2026-11-14-login-lockout.sql). false = tidak ada baris/kunci untuk dibuka — itu berita
    // biasa, bukan error.
    const unlockBtn = e.target.closest("[data-unlock-user]");
    if (unlockBtn) {
      const username = unlockBtn.dataset.unlockUser;
      if (!confirm(`Buka kunci login ${username}?`)) return;
      unlockBtn.disabled = true;
      try {
        const viaRpc = await supabase.rpc("admin_action", {
          ...adminActor(),
          p_action: "unlock", p_target: username,
        });
        if (viaRpc.error) {
          if (!adminActionMissing(viaRpc.error)) throw viaRpc.error;
          throw new Error(ADMIN_MIGRATION_MESSAGE);
        }
        setMessage(
          "userMessage",
          viaRpc.data === false
            ? `${username}: tidak ada kunci login untuk dibuka (atau migrasi kunci login belum dijalankan).`
            : `Kunci login ${username} dibuka.`
        );
      } catch (err) {
        setMessage("userMessage", "Gagal: " + err.message, true);
      } finally {
        unlockBtn.disabled = false;
      }
      return;
    }

    const delBtn = e.target.closest("[data-delete-user]");
    if (delBtn) {
      const username = delBtn.dataset.deleteUser;
      if (!confirm(`Hapus user ${username} permanen?`)) return;
      delBtn.disabled = true;
      try {
        const viaRpc = await supabase.rpc("admin_action", {
          ...adminActor(),
          p_action: "delete", p_target: username,
        });
        if (viaRpc.error) {
          if (!rpcMissing(viaRpc.error)) throw viaRpc.error;
          const { error } = await supabase.from("users_custom").delete().eq("username", username);
          if (error) throw error;
        }
        setMessage("userMessage", `${username} dihapus.`);
        loadUsers();
        loadStats();
      } catch (err) {
        setMessage("userMessage", "Gagal: " + err.message, true);
        delBtn.disabled = false;
      }
    }
  };

  // Add admin
  document.getElementById("addAdminForm").onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById("newAdminUsername").value.trim().toLowerCase();
    const password = document.getElementById("newAdminPassword").value;
    if (username.includes(" ")) return setMessage("addAdminMessage", "Username tidak boleh spasi.", true);
    if (password.length < 6) return setMessage("addAdminMessage", "Sandi minimal 6 karakter.", true);
    const btn = document.getElementById("addAdminBtn");
    btn.disabled = true;
    btn.textContent = "Menyimpan...";
    try {
      const viaRpc = await supabase.rpc("admin_action", {
        ...adminActor(),
        p_action: "create", p_target: username, p_role: "admin", p_password: password,
      });
      if (!viaRpc.error && viaRpc.data === false) { setMessage("addAdminMessage", "Username sudah ada.", true); return; }
      if (viaRpc.error) {
        if (!rpcMissing(viaRpc.error)) throw viaRpc.error;
        const passwordHash = await hashPassword(password);
        const { data: existing } = await supabase.from("users_custom").select("username").eq("username", username).maybeSingle();
        if (existing) { setMessage("addAdminMessage", "Username sudah ada.", true); return; }
        const { error } = await supabase.from("users_custom").insert([{ username, password_hash: passwordHash, role: "admin" }]).select("username, role");
        if (error) throw error;
      }
      setMessage("addAdminMessage", `Admin ${username} dibuat.`);
      document.getElementById("newAdminUsername").value = "";
      document.getElementById("newAdminPassword").value = "";
      loadUsers();
      loadStats();
    } catch (err) {
      setMessage("addAdminMessage", "Gagal: " + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "Tambah Admin";
    }
  };
}


// Sekali saat halaman Workers dibuka: buang sisa simpanan fitur kuota yang sudah dibuang dari
// panel (kuota harian, ambang gate, dan snapshot per akun `accountQuotaGate*`) supaya localStorage
// tidak menyimpan data yang tidak lagi dibaca siapa pun. Kunci yang tidak ada diabaikan.
function purgeLegacyQuotaStorage() {
  if (!$("workerList")) return;
  localStorage.removeItem("workerDailyQuota");
  localStorage.removeItem("accountQuotaThreshold");
  const stale = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith("accountQuotaGate")) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}

async function init() {
  const authOk = await checkAuth();
  if (authOk) {
    await loadState();
    purgeLegacyQuotaStorage();
    renderNav();
    renderAuth();
    if (currentUser) {
      renderDashboard();
      renderWorkers();
      renderGenerator();
      renderDeploy();
      renderProxyManager();
      renderAdmin();
    }
  }
}

init();




// proxyPoolRow memetakan satu baris mentah `proxy_pool` (proyeksi `*` maupun proyeksi bertahap
// pemilih proxy) ke bentuk yang dibaca proxyEvidence/proxyHealth. `tunnel` null = belum pernah
// diprobe (bukan mati), dan bukti host dari panproxyscanner datang lewat `tunnel_host_ok` (kolom
// baru) atau `tls_ok` (kolom lama) — hanya nilai true yang jadi bukti.
function proxyPoolRow(p) {
  return {
    ip: p.ip,
    port: String(p.port),
    country: p.country || "",
    org: p.org || "",
    checked: p.last_checked || "",
    ping: Number(p.ping) || 0,
    tunnel: typeof p.tunnel_ok === "boolean" ? p.tunnel_ok : null,
    tunnelMs: Number(p.tunnel_ms) || 0,
    hostTunnel: p.tunnel_host_ok === true,
    hostTunnelMs: Number(p.tunnel_host_ms) || 0,
    tls: p.tls_ok === true,
  };
}

// Ganti proxy manager script yg lama jadi logic Supabase
function renderProxyManager() {
  if (!document.getElementById('dbProxyForm')) return;

  let currentList = [];
  let viewMode = 'live';
  let sortMode = 'recent'; // bawaan: terbaru (urutan server), sama seperti sebelum ada tombol urut

  const CACHE_KEY = "proxyListCache";
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  const fmtDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // Urutan tampilan: "terbaru" (bawaan, sama dengan urutan server), "negara", atau "ping". Baris
  // yang ping-nya 0/ kosong (belum pernah dicek) selalu di belakang — bukan dianggap 0 ms.
  const sortRows = (list) => {
    const rows = list.slice();
    if (sortMode === 'country') {
      return rows.sort((a, b) => String(a.country || '').localeCompare(String(b.country || '')) || String(a.ip).localeCompare(String(b.ip)));
    }
    if (sortMode === 'ping') {
      const ping = (p) => (Number(p.ping) > 0 ? Number(p.ping) : Infinity);
      return rows.sort((a, b) => ping(a) - ping(b));
    }
    return rows.sort((a, b) => (Date.parse(b.last_checked || '') || 0) - (Date.parse(a.last_checked || '') || 0));
  };

  // Ringkasan per negara dihitung ULANG lewat proxyHealth (segar < 6 jam, vonis edge, dst) supaya
  // angkanya tidak bisa menyimpang dari daftar di bawahnya. Uji satu proxy TIDAK dijalankan dari
  // browser (API proxy tidak bisa dipanggil dari sini) — tautan UI scanner yang disediakan.
  const renderCountrySummary = () => {
    const el = document.getElementById('proxyCountrySummary');
    if (!el) return;
    const groups = new Map();
    for (const row of currentList) {
      const code = String(row.country || '').toUpperCase() || '—';
      if (!groups.has(code)) groups.set(code, []);
      groups.get(code).push(proxyPoolRow(row));
    }
    const rows = [...groups.keys()].sort().map((code) => {
      const health = proxyHealth(groups.get(code), []);
      return `<tr><td>${getFlagEmoji(code)} ${escapeHtml(code)}</td><td>${health.total}</td><td>${health.fresh}</td><td>${health.edgeCount}</td><td>${health.knownDead}</td></tr>`;
    }).join('');
    el.innerHTML = groups.size
      ? `<table class="proxy-table"><thead><tr><th>Negara</th><th>Total</th><th>Segar (&lt;6 jam)</th><th>Terbukti edge</th><th>Mati di edge</th></tr></thead><tbody>${rows}</tbody></table>`
        + `<p class="form-message" style="min-height:0">Ringkasan dari ${currentList.length} baris proxy_pool. Uji satu proxy tidak bisa dijalankan dari browser — pakai <a href="${SCANNER_URL}" target="_blank" rel="noopener">UI scanner</a>.</p>`
      : '';
  };

  // Tombol urut dan tabel ringkasan dibuat dari sini: elemennya dipakai kalau sudah ada di HTML,
  // jadi menambahkannya ke proxy.html nanti tidak menghasilkan kontrol kembar.
  const ensureProxyControls = () => {
    const tabs = document.querySelector('.proxy-tabs');
    if (tabs && !document.getElementById('proxySortBtns')) {
      const bar = document.createElement('div');
      bar.id = 'proxySortBtns';
      bar.className = 'proxy-tabs';
      bar.style.marginTop = '10px';
      bar.innerHTML = '<button class="button secondary proxy-tab" id="proxySortRecentBtn" type="button">Urut: terbaru</button>'
        + '<button class="button secondary proxy-tab" id="proxySortCountryBtn" type="button">Urut: negara</button>'
        + '<button class="button secondary proxy-tab" id="proxySortPingBtn" type="button">Urut: ping</button>';
      tabs.parentNode.insertBefore(bar, tabs.nextSibling);
    }
    const wrap = document.querySelector('.proxy-table-wrap');
    if (wrap && !document.getElementById('proxyCountrySummary')) {
      const box = document.createElement('div');
      box.id = 'proxyCountrySummary';
      box.style.marginBottom = '14px';
      wrap.parentNode.insertBefore(box, wrap);
    }
  };

  const renderTable = () => {
    renderCountrySummary();
    const list = sortRows(currentList.filter(p => viewMode === 'live' ? p.is_active : !p.is_active));
    const tbody = document.getElementById('proxyTableBody');
    const empty = document.getElementById('proxyEmpty');
    document.getElementById('dbCount').textContent = list.length;

    if (!list.length) {
      tbody.innerHTML = '';
      empty.hidden = false;
      empty.textContent = viewMode === 'live' ? 'Belum ada proxy aktif.' : 'Tidak ada proxy mati.';
      return;
    }
    empty.hidden = true;
    tbody.innerHTML = list.map(p => {
      const flag = p.country ? getFlagEmoji(p.country) : '🏳';
      // Baris di sini datang sebagai baris mentah `proxy_pool` (proyeksi `*`), jadi kolomnya
      // dibaca apa adanya: `tunnel_ok` = bukti edge, `tunnel_host_ok`/`tls_ok` = bukti host.
      const ev = proxyEvidence({
        tunnel: typeof p.tunnel_ok === 'boolean' ? p.tunnel_ok : null,
        hostTunnel: p.tunnel_host_ok === true,
        tls: p.tls_ok === true,
        tunnelMs: p.tunnel_ms,
        hostTunnelMs: p.tunnel_host_ms,
      });
      const proof = p.tunnel_ok === false
        // Vonis edge yang menentukan (worker VLESS jalan di edge): baris begini tidak boleh
        // tampak sehat walau host bilang tembus.
        ? ` <span class="badge" title="probe tunnel dari edge terakhir gagal: proxy tidak meneruskan paket">✗ mati di edge</span>`
        : ev.kind
          ? ` <span class="badge" title="bukti ${ev.kind}${ev.ms ? ` ${ev.ms} ms` : ''}${p.tunnel_host_checked ? ` · host dicek ${fmtDate(p.tunnel_host_checked)}` : ''}">${evidenceLabel(ev)}</span>`
          : '';
      const status = p.is_active ? `<span class="proxy-status live">Aktif</span>${proof}` : '<span class="proxy-status dead">Mati</span>';
      const address = `${p.ip}:${p.port}`;
      return `<tr><td><code>${escapeHtml(address)}</code> <button class="icon-button" data-copy-proxy="${escapeHtml(address)}" type="button">Copy</button></td><td>${flag} ${escapeHtml(p.country || '—')}</td><td>${escapeHtml(p.org || '—')}</td><td>${status}</td><td>${fmtDate(p.last_checked)}</td></tr>`;
    }).join('');
  };

  const loadProxies = async (force = false) => {
    setMessage('dbProxyMessage', 'Memuat proxy...');
    // Cek cache dulu
    if (!force) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
          currentList = cached.data;
          renderTable();
          setMessage('dbProxyMessage', `${currentList.length} proxy (cached).`);
          return;
        }
      } catch {}
    }
    // Fetch fresh
    if (!supabase) { setMessage('dbProxyMessage', 'Supabase tidak terkoneksi.', true); return; }
    try {
      const { data, error } = await supabase.from('proxy_pool').select('*').order('last_checked', { ascending: false });
      if (error) throw error;
      currentList = data || [];
      renderTable();
      localStorage.setItem(CACHE_KEY, JSON.stringify({ data: currentList, ts: Date.now() }));
      setMessage('dbProxyMessage', `${currentList.length} proxy dimuat.`);
    } catch (e) {
      setMessage('dbProxyMessage', 'Error: ' + e.message, true);
    }
  };

  ensureProxyControls();
  const sortButtons = { recent: 'proxySortRecentBtn', country: 'proxySortCountryBtn', ping: 'proxySortPingBtn' };
  const updateSortTabs = () => {
    for (const [mode, id] of Object.entries(sortButtons)) document.getElementById(id)?.classList.toggle('active', sortMode === mode);
  };
  for (const [mode, id] of Object.entries(sortButtons)) {
    const btn = document.getElementById(id);
    if (btn) btn.onclick = () => { sortMode = mode; updateSortTabs(); renderTable(); };
  }
  updateSortTabs();

  const proxyBody = document.getElementById('proxyTableBody');
  if (proxyBody) proxyBody.onclick = (event) => {
    const btn = event.target.closest('[data-copy-proxy]');
    if (!btn) return;
    // Clipboard bisa ditolak (mis. konteks bukan HTTPS); labelnya tetap ditampilkan apa adanya
    // supaya tidak ada penolakan yang hilang tanpa jejak.
    navigator.clipboard.writeText(btn.dataset.copyProxy).catch(() => {});
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  };

  loadProxies();

  document.getElementById('tabLiveBtn').onclick = () => { viewMode = 'live'; updateTabs(); renderTable(); };
  document.getElementById('tabDeadBtn').onclick = () => { viewMode = 'dead'; updateTabs(); renderTable(); };
  const updateTabs = () => {
    document.getElementById('tabLiveBtn').classList.toggle('active', viewMode === 'live');
    document.getElementById('tabDeadBtn').classList.toggle('active', viewMode === 'dead');
  };

  document.getElementById('copyDbProxyBtn').onclick = async () => {
    const list = currentList.filter(p => viewMode === 'live' ? p.is_active : !p.is_active);
    const txt = list.map(p => p.ip + ':' + p.port).join('\n');
    await navigator.clipboard.writeText(txt);
    setMessage('dbProxyMessage', `${list.length} IP disalin!`);
  };

  document.getElementById('dbProxyForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!supabase) return setMessage('dbProxyMessage', 'Supabase tidak terkoneksi.', true);

    const rawList = document.getElementById('dbProxyInput').value.split(/[\n,]+/).map(i => i.trim()).filter(Boolean);
    if (!rawList.length) return;

    const btn = document.getElementById('addProxyBtn');
    btn.disabled = true;
    btn.textContent = 'Mengecek...';
    setMessage('dbProxyMessage', `Mengecek ${rawList.length} proxy...`);

    const live = [];
    const dead = [];

    for (let i = 0; i < rawList.length; i++) {
      const item = rawList[i];
      let host = item, port = '443';
      if (item.includes(':')) {
        const parts = item.split(':');
        host = parts[0];
        port = parts[1] || '443';
      }
      btn.textContent = `Cek ${i+1}/${rawList.length}...`;
      try {
        const res = await fetch(`https://id1.foolvpn.web.id/api/v1/check?ip=${host}:${port}`, { signal: AbortSignal.timeout(5000) });
        const data = res.ok ? await res.json().catch(() => null) : null;
        if (data && data.tcp_port_open) {
          live.push({ ip: host, port, is_active: true, country: data.country_code || '??', org: data.isp || 'Unknown' });
        } else {
          dead.push(`${host}:${port}`);
        }
      } catch {
        dead.push(`${host}:${port}`);
      }
    }

    if (live.length) {
      const { error } = await supabase.from('proxy_pool').insert(live);
      if (error) {
        setMessage('dbProxyMessage', `Gagal simpan: ${error.message}`, true);
        btn.disabled = false;
        btn.textContent = 'Cek & Tambah';
        return;
      }
    }

    btn.disabled = false;
    btn.textContent = 'Cek & Tambah';
    document.getElementById('dbProxyInput').value = '';

    let msg = `${live.length} proxy aktif ditambahkan.`;
    if (dead.length) msg += ` ${dead.length} mati dilewati: ${dead.slice(0, 5).join(', ')}${dead.length > 5 ? '...' : ''}`;
    setMessage('dbProxyMessage', msg);

    localStorage.removeItem(CACHE_KEY);
    loadProxies(true);
  };
}


