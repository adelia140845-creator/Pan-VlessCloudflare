import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { redeployPlan, redeployProgressLine, rateLimitInfo, summarizeRedeploy, ensureSubToken, withSubToken, createSubToken, appendHealthSample, summarizeHealthHistory, formatCheckedAt, versionStateFromHealth, pruneHealthCache, healthSampleFromProbe, WORKER_HEALTH_CACHE_KEY, quotaGate, groupUsageByAccount, clampQuotaThreshold, ACCOUNT_QUOTA_THRESHOLD_KEY, ACCOUNT_QUOTA_THRESHOLD_DEFAULT } from "./redeploy.js";
import { qrTargets, renderQrInto } from "./qr.js";
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
// Hapus deklarasi lama yang tergabung dengan function lain
function validHost(host) { return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) && !host.includes(".."); }

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
const LB_TEMPLATE_VERSION = "2026-11-15a";
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

function healthBlockHtml(worker) {
  // Worker dari akun yang mencapai ambang kuota tidak diperiksa /health: satu probe = satu request
  // ke worker, persis request yang sedang dijaga. Kartu menyebut alasannya, bukan "mati".
  const block = quotaBlockOf(worker);
  if (block) {
    const percent = block.percent === null || block.percent === undefined ? "?" : block.percent;
    return `<div><span class="badge" style="border-color:${QUOTA_BLOCKED_BADGE_COLOR};color:#fca5a5">pemeriksaan /health dilewati</span> kuota akun ${percent}% — supaya tidak menambah request saat kuota kritis.</div>`;
  }
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
// worker aktif yang diperiksa (worker nonaktif memang tidak diharapkan menjawab). Worker yang
// diblokir gate kuota akun dilewati: probe = request, dan request itulah yang dijaga.
async function checkWorkerHealth(workers) {
  await Promise.all(
    workers
      .filter((w) => w.active && !quotaBlockOf(w))
      .map(async (worker) => recordHealthSample(worker, await probeWorker(worker)))
  );
}

// Tombol "Cek semua": BERURUTAN (satu per satu) supaya progresnya terlihat dan tidak membanjiri
// worker sekaligus. Ringkasan akhir menyebut worker mana yang tidak menjawab.
async function checkAllWorkerHealth() {
  // Worker yang diblokir gate kuota akun tidak diperiksa (probe = request) dan disebutkan terpisah.
  const gated = state.workers.filter((worker) => worker.active && quotaBlockOf(worker));
  const workers = state.workers.filter((worker) => worker.active && !quotaBlockOf(worker));
  const button = $("checkAllHealth");
  const gatedNote = gated.length ? ` ${gated.length} worker dilewati karena kuota akunnya mencapai ambang: ${gated.map((worker) => worker.name).join(", ")}.` : "";

  if (!workers.length) {
    setMessage("workersMessage", `Tidak ada worker aktif yang bisa diperiksa.${gatedNote}`, true);
    return;
  }

  if (button) button.disabled = true;
  try {
    const results = [];
    for (let index = 0; index < workers.length; index += 1) {
      const worker = workers[index];
      setMessage("workersMessage", `memeriksa ${index + 1}/${workers.length}: ${worker.name}...`);
      const sample = await probeWorker(worker);
      recordHealthSample(worker, sample);
      results.push({ name: worker.name, ok: sample.up });
      // Biarkan browser menggambar baris progres sebelum worker berikutnya diperiksa.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const down = results.filter((item) => !item.ok);
    setMessage(
      "workersMessage",
      (down.length
        ? `Selesai: ${results.length - down.length}/${results.length} worker hidup. Tidak menjawab: ${down.map((item) => item.name).join(", ")}.`
        : `Selesai: semua ${results.length} worker aktif menjawab /health.`) + gatedNote,
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

// Tombol "Statistik": minta pemakaian worker dari /api/workers-stats (Cloudflare GraphQL lewat
// Pages Function, karena API Cloudflare tidak bisa dipanggil dari browser). Kredensial dibaca
// langsung dari panel di atas dan tidak pernah disimpan.
async function showWorkerStats(worker, button) {
  const outId = `stats-${worker.id}`;
  const email = ($("statsCfEmail")?.value || "").trim();
  const apiKey = ($("statsCfApiKey")?.value || "").trim();
  const accountId = ($("statsCfAccountId")?.value || "").trim();

  if (!email || !apiKey || !accountId) {
    setMessage("statsPanelMessage", "Isi Email Cloudflare, Global API Key, dan Account ID dulu untuk melihat statistik.", true);
    $("statsCfEmail")?.focus();
    return;
  }

  const hoursInput = Number.parseInt(($("statsHours")?.value || "").trim(), 10);
  const hours = Number.isFinite(hoursInput) && hoursInput > 0 ? Math.min(hoursInput, 720) : 24;
  const wasDisabled = button.disabled;
  button.disabled = true;
  setMessage(outId, `Mengambil statistik ${worker.name} (${hours} jam terakhir)...`);

  try {
    const res = await fetch("/api/workers-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cfEmail: email,
        cfApiKey: apiKey,
        accountId: accountId,
        scriptName: worker.name,
        hours: hours,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !(data && data.success)) {
      throw new Error((data && data.error) || `Permintaan statistik gagal (HTTP ${res.status})`);
    }
    setMessage(
      outId,
      `${data.hours} jam terakhir: ${Number(data.requests || 0).toLocaleString("id-ID")} permintaan, ${Number(data.errors || 0).toLocaleString("id-ID")} error.`
    );
  } catch (error) {
    setMessage(outId, (error && error.message) || "Statistik gagal diambil.", true);
  } finally {
    button.disabled = wasDisabled;
  }
}

// --- Panel "Kuota hari ini (UTC)" -------------------------------------------
// Memakai /api/workers-stats mode `period: "today"` + `scriptNames`: satu permintaan GraphQL
// ber-alias untuk semua Worker (jatah analitik Cloudflare 10 permintaan/10 menit, jadi satu
// permintaan per halaman — bukan per worker). Kuota plan TIDAK dibaca dari API (endpoint billing
// menolak); angka kuota adalah isian yang disimpan di localStorage dan bawaan 100.000/hari.
// Kunci `workerDailyQuota` dipertahankan apa adanya (data pengguna lama), tetapi artinya kini
// KUOTA PER AKUN: Cloudflare menghitung jatah 100.000 request/hari per akun, jadi pemakaian semua
// worker satu akun dijumlahkan sebelum dibandingkan (lihat groupUsageByAccount/quotaGate).
const WORKER_DAILY_QUOTA_KEY = "workerDailyQuota";
const WORKER_DAILY_QUOTA_DEFAULT = 100000;
const CLOUDFLARE_SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const QUOTA_MAX_SCRIPTS = 10;
const QUOTA_LEVEL_COLOR = { ok: "#22c55e", warn: "#f59e0b", over: "#ef4444" };

function readWorkerDailyQuota() {
  const saved = Number.parseInt(localStorage.getItem(WORKER_DAILY_QUOTA_KEY) || "", 10);
  return Number.isFinite(saved) && saved > 0 ? saved : WORKER_DAILY_QUOTA_DEFAULT;
}

// saveWorkerDailyQuota menyimpan isian kuota; nilai tidak sah menghapus simpanan dan kembali ke
// bawaan (bukan menyimpan 0 yang membuat semua bar berwarna bahaya).
function saveWorkerDailyQuota(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    localStorage.removeItem(WORKER_DAILY_QUOTA_KEY);
    return WORKER_DAILY_QUOTA_DEFAULT;
  }
  localStorage.setItem(WORKER_DAILY_QUOTA_KEY, String(parsed));
  return parsed;
}

// --- Penjaga kuota per akun (ambang 90%) ------------------------------------
// Isian kuota di atas dipakai sebagai kuota PER AKUN, bukan per worker: jatah request harian
// Cloudflare dihitung per akun, jadi pemakaian semua worker milik satu akun dijumlahkan lebih dulu
// (groupUsageByAccount di redeploy.js) sebelum dibandingkan dengan ambang.
//
// Hasil terakhir disimpan di localStorage (ACCOUNT_QUOTA_GATE_KEY) beserta tanggal UTC-nya supaya
// halaman Generator — yang tidak memegang kredensial Cloudflare — ikut menyembunyikan worker dari
// akun yang sudah mencapai ambang. Simpanan hari lain diabaikan: pemakaian Cloudflare reset 00:00
// UTC. Tanpa simpanan hari ini, gate MATI dan semua worker tetap ditawarkan (tidak memblokir tanpa
// bukti).
const ACCOUNT_QUOTA_GATE_KEY = "accountQuotaGate";
const QUOTA_BLOCKED_BADGE_COLOR = "#ef4444";

let quotaGateState = { snapshot: null, threshold: ACCOUNT_QUOTA_THRESHOLD_DEFAULT, blocked: new Map() };

function readAccountQuotaThreshold() {
  const saved = Number.parseInt(localStorage.getItem(ACCOUNT_QUOTA_THRESHOLD_KEY) || "", 10);
  return Number.isFinite(saved) ? clampQuotaThreshold(saved) : ACCOUNT_QUOTA_THRESHOLD_DEFAULT;
}

// saveAccountQuotaThreshold menyimpan ambang yang sudah dijepit ke 50-100% (clampQuotaThreshold).
function saveAccountQuotaThreshold(value) {
  const threshold = clampQuotaThreshold(value);
  localStorage.setItem(ACCOUNT_QUOTA_THRESHOLD_KEY, String(threshold));
  return threshold;
}

// utcDayKey = tanggal UTC (YYYY-MM-DD), batas yang sama dengan jendela "hari ini" Cloudflare.
function utcDayKey(at) {
  return new Date(at).toISOString().slice(0, 10);
}

// refreshQuotaGateState membaca simpanan gate dan menyiapkan peta worker yang diblokir. Simpanan
// yang bukan hari ini (atau rusak) dibuang, bukan dipakai: angka kemarin tidak boleh memblokir
// worker hari ini.
function refreshQuotaGateState() {
  let snapshot = null;
  try {
    const parsed = JSON.parse(localStorage.getItem(ACCOUNT_QUOTA_GATE_KEY) || "null");
    if (parsed && typeof parsed === "object" && parsed.accounts && typeof parsed.accounts === "object") {
      snapshot = parsed;
    }
  } catch {}

  if (snapshot && snapshot.day !== utcDayKey(Date.now())) snapshot = null;

  const blocked = new Map(); // workerId -> { accountId, percent }
  if (snapshot) {
    for (const [accountId, account] of Object.entries(snapshot.accounts)) {
      if (!account || account.blocked !== true) continue;
      for (const worker of Array.isArray(account.workers) ? account.workers : []) {
        if (worker && worker.id) blocked.set(String(worker.id), { accountId: accountId, percent: account.percent });
      }
    }
  }

  quotaGateState = {
    snapshot: snapshot,
    threshold: snapshot ? clampQuotaThreshold(snapshot.threshold) : readAccountQuotaThreshold(),
    blocked: blocked,
  };
  return quotaGateState;
}

// quotaBlockOf = penanda blokir satu worker (dari akun yang mencapai ambang), atau null.
function quotaBlockOf(worker) {
  return worker && worker.id ? quotaGateState.blocked.get(String(worker.id)) || null : null;
}

// quotaBadgeHtml = badge merah di kartu worker. Hanya dirender untuk worker yang diblokir; worker
// lain tidak diberi badge (supaya tidak ada badge kosong yang menakutkan).
function quotaBadgeHtml(worker) {
  const block = quotaBlockOf(worker);
  if (!block) return "";
  const percent = block.percent === null || block.percent === undefined ? "?" : block.percent;
  return `<span class="badge" style="border-color:${QUOTA_BLOCKED_BADGE_COLOR};color:#fca5a5">kuota akun ${percent}% — berhenti menawarkan config baru</span>`;
}

// renderQuotaGateStatus menyatakan dengan jujur apakah gate menyala. Selama data pemakaian hari ini
// belum ada (belum dimuat, atau token tanpa izin Analytics), gate TIDAK aktif dan pesannya menyebut
// itu — bukan diam-diam memblokir maupun diam-diam melewatkan.
function renderQuotaGateStatus() {
  const el = $("quotaGateStatus");
  if (!el) return;
  const snapshot = quotaGateState.snapshot;
  if (!snapshot) {
    el.textContent =
      "Gate kuota akun TIDAK AKTIF: pemakaian hari ini belum dimuat, jadi semua worker tetap ditawarkan untuk config baru. Isi kredensial lalu tekan \u201cMuat ulang\u201d untuk mengaktifkannya.";
    el.classList.add("error");
    return;
  }
  const blockedAccounts = Object.entries(snapshot.accounts).filter(([, account]) => account && account.blocked === true);
  const blockedWorkers = quotaGateState.blocked.size;
  const time = Number.isFinite(snapshot.savedAt) ? new Date(snapshot.savedAt).toLocaleTimeString("id-ID") : "?";
  el.classList.remove("error");
  el.textContent = blockedWorkers
    ? `Gate kuota akun AKTIF (ambang ${quotaGateState.threshold}% · data ${time}): ${blockedWorkers} worker dari ${blockedAccounts.length} akun berhenti ditawarkan untuk config/subscription baru. Worker TIDAK dinonaktifkan di Cloudflare.`
    : `Gate kuota akun AKTIF (ambang ${quotaGateState.threshold}% · data ${time}): belum ada akun yang mencapai ambang, semua worker tetap ditawarkan.`;
}

function quotaNumber(value) {
  return Number(value || 0).toLocaleString("id-ID");
}

// quotaBarHtml menggambar bar warna: aman <80% (hijau), peringatan 80-100% (kuning), bahaya >100%
// (merah). Lebar bar dipotong di 100% supaya pemakaian di atas kuota tidak merusak tata letak;
// warnanya yang menyatakan kelebihan.
function quotaBarHtml(percent, level) {
  const width = Math.max(0, Math.min(100, Number(percent) || 0));
  const color = QUOTA_LEVEL_COLOR[level] || "#64748b";
  return `<span style="display:block;height:8px;background:rgba(148,163,184,.25);border-radius:999px;overflow:hidden"><span style="display:block;height:8px;width:${width}%;background:${color}"></span></span>`;
}

function quotaRemainingText(summary) {
  if (!summary || summary.remaining === null) return "";
  if (summary.remaining < 0) return `lebih ${quotaNumber(Math.abs(summary.remaining))} dari kuota`;
  return `sisa ${quotaNumber(summary.remaining)}`;
}

// quotaWorkerNames memilih Worker yang namanya SAH sebagai nama script Cloudflare. Nama alias
// seperti "VPN SG 1" tidak akan pernah cocok dengan scriptName Cloudflare, jadi tidak dikirim dan
// disebutkan terpisah — bukan diam-diam dianggap 0 request.
//
// Hanya Worker milik akun yang diminta yang dikirim: kueri Cloudflare dibatasi ke satu akun, jadi
// nama script milik akun LAIN tidak akan punya alias di balasan dan seluruh permintaan akan
// ditolak 400. Worker tanpa `accountId` ikut akun yang diisi (asumsi satu akun); jumlah Worker
// akun lain dilaporkan terpisah supaya tidak tampak terhitung.
function quotaWorkerNames(accountId) {
  const wanted = typeof accountId === "string" ? accountId.trim() : "";
  const scoped = state.workers.filter((worker) => {
    const own = String(worker.accountId || "").trim();
    return !own || own === wanted;
  });
  const all = scoped.map((worker) => String(worker.name || "").trim()).filter(Boolean);
  const unique = [...new Set(all)];
  const valid = unique.filter((name) => CLOUDFLARE_SCRIPT_NAME.test(name));
  return {
    workers: scoped,
    names: valid.slice(0, QUOTA_MAX_SCRIPTS),
    skipped: unique.filter((name) => !CLOUDFLARE_SCRIPT_NAME.test(name)),
    truncated: Math.max(0, valid.length - QUOTA_MAX_SCRIPTS),
    excluded: state.workers.length - scoped.length,
  };
}

// renderTodayQuota menggambar tabel PER AKUN (bukan per worker): satu baris akun berisi jumlah
// request semua worker akun itu terhadap kuota harian akun, lalu daftar worker di dalamnya.
// Sumbernya simpanan gate (quotaGateState.snapshot) supaya tabel yang tampil setelah halaman
// dibuka ulang sama dengan yang dipakai gate — bukan angka baru yang belum dihitung apa pun.
function renderTodayQuota(snapshot) {
  const table = $("quotaTable");
  if (!table) return;
  const accounts = snapshot && snapshot.accounts ? Object.entries(snapshot.accounts) : [];
  if (!accounts.length) {
    table.innerHTML = "";
    return;
  }
  const quota = Number(snapshot.quota) || 0;
  const cell = 'style="padding:6px 8px;border-bottom:1px solid rgba(148,163,184,.18)"';
  const barCell = 'style="padding:6px 8px;border-bottom:1px solid rgba(148,163,184,.18);min-width:120px"';
  const headline = 'style="padding:6px 8px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em"';

  const rows = accounts.map(([accountId, account]) => {
    const percentText = account.percent === null || account.percent === undefined ? "kuota tidak diisi" : `${account.percent}% terpakai`;
    const remainingText = quotaRemainingText({ remaining: account.remaining === undefined ? null : account.remaining });
    const gateBadge = account.blocked
      ? `<div style="margin-top:6px"><span class="badge" style="border-color:${QUOTA_BLOCKED_BADGE_COLOR};color:#fca5a5">kuota akun ${account.percent}% — berhenti menawarkan config baru</span></div>`
      : "";
    const workerRows = (Array.isArray(account.workers) ? account.workers : [])
      .map((worker) => `<li><code>${escapeHtml(worker.name || "")}</code> · ${quotaNumber(worker.used)} request${worker.errors ? ` · ${quotaNumber(worker.errors)} error` : ""}</li>`)
      .join("");
    return (
      `<tr><td ${cell}><code>${escapeHtml(accountId)}</code>${gateBadge}</td>` +
      `<td ${cell}>${quotaNumber(account.used)} / ${quotaNumber(quota)}</td>` +
      `<td ${cell}>${percentText}${remainingText ? " · " + remainingText : ""}${account.errors ? ` · ${quotaNumber(account.errors)} error` : ""}</td>` +
      `<td ${barCell}>${quotaBarHtml(account.percent, account.level)}</td></tr>` +
      `<tr><td colspan="4" ${cell}><span style="color:#94a3b8;font-size:12px">worker di akun ini (${(account.workers || []).length})</span><ul style="margin:4px 0 2px 18px;font-size:13px">${workerRows || "<li><i>tidak ada</i></li>"}</ul></td></tr>`
    );
  }).join("");

  const unattributed = Array.isArray(snapshot.unattributed) ? snapshot.unattributed : [];
  const unattributedRow = unattributed.length
    ? `<tr><td colspan="4" ${cell}><span class="form-message error" style="min-height:0">Tanpa Account ID (tidak ikut dihitung gate): ${escapeHtml(unattributed.join(", "))}. Isi Account ID di panel Statistik Cloudflare atau deploy ulang worker itu dari halaman Deploy.</span></td></tr>`
    : "";

  table.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:14px"><thead><tr><th ${headline}>Akun Cloudflare</th><th ${headline}>Terpakai / kuota</th><th ${headline}>Persen · sisa</th><th ${headline}>Bar</th></tr></thead><tbody>${rows}${unattributedRow}</tbody></table>`;
}

// loadTodayQuota mengambil pemakaian hari ini (UTC) untuk semua Worker terdaftar dalam SATU
// permintaan. Saat Cloudflare menolak (mis. token tanpa izin Analytics) tabel dikosongkan dan
// hanya pesan penolakan yang ditampilkan: tidak ada angka 0 karangan.
async function loadTodayQuota(button) {
  const email = ($("statsCfEmail")?.value || "").trim();
  const apiKey = ($("statsCfApiKey")?.value || "").trim();
  const accountId = ($("statsCfAccountId")?.value || "").trim();
  const quota = saveWorkerDailyQuota($("workerDailyQuota")?.value);

  if (!email || !apiKey || !accountId) {
    setMessage("statsPanelMessage", "Isi Email Cloudflare, Global API Key, dan Account ID dulu untuk melihat kuota hari ini.", true);
    $("statsCfEmail")?.focus();
    return;
  }

  const picked = quotaWorkerNames(accountId);
  if (!picked.names.length) {
    if ($("quotaTable")) $("quotaTable").innerHTML = "";
    setMessage("quotaFetchedAt", "");
    refreshQuotaGateState();
    renderQuotaGateStatus();
    setMessage(
      "quotaMessage",
      state.workers.length
        ? picked.skipped.length
          ? `Nama Worker tidak bisa dipakai sebagai nama script Cloudflare (hanya huruf kecil, angka, "-" dan "_"): ${picked.skipped.join(", ")}.`
          : `Tidak ada Worker yang bisa dihitung untuk akun ini: ${picked.excluded} Worker terdaftar milik akun lain.`
        : "Belum ada Worker terdaftar. Tambahkan Worker dulu supaya pemakaian kuota bisa dihitung.",
      true
    );
    return;
  }

  const wasDisabled = button ? button.disabled : false;
  if (button) button.disabled = true;
  setMessage("quotaFetchedAt", "");
  setMessage("quotaMessage", `Mengambil pemakaian hari ini (UTC) untuk ${picked.names.length} worker...`);

  try {
    const res = await fetch("/api/workers-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cfEmail: email,
        cfApiKey: apiKey,
        accountId: accountId,
        period: "today",
        scriptNames: picked.names,
        dailyQuota: quota,
      }),
    });
    const data = await res.json().catch(() => null);
    if ($("quotaTable")) $("quotaTable").innerHTML = "";

    if (!res.ok || !(data && data.ok)) {
      const base = (data && data.error) || `Permintaan kuota gagal (HTTP ${res.status})`;
      // Data baru tidak tersedia: gate mengikuti simpanan hari ini (kalau ada) atau MATI. Tabel
      // tetap menampilkan simpanan terakhir supaya angkanya kelihatan pernah diambil kapan.
      refreshQuotaGateState();
      renderQuotaGateStatus();
      if (quotaGateState.snapshot) renderTodayQuota(quotaGateState.snapshot);
      renderWorkers({ probe: false });
      const inactiveNote = quotaGateState.snapshot
        ? " Gate memakai data pemakaian terakhir yang tersimpan (lihat status di bawah), bukan data baru."
        : " Gate kuota akun TIDAK AKTIF sampai data pemakaian hari ini berhasil diambil, jadi semua worker tetap ditawarkan.";
      setMessage(
        "quotaMessage",
        (data && data.needsScope
          ? `${base} Angka pemakaian tidak ditampilkan sampai izin itu ditambahkan pada token.`
          : base) + inactiveNote,
        true
      );
      return;
    }

    // Agregasi per akun: jumlah request semua worker milik akun yang sama. Worker lama tanpa
    // `accountId` (deploy sebelum panel menyimpannya) memakai Account ID yang diisi di panel —
    // asumsi satu akun, disebutkan di UI. Hanya Worker dalam lingkup akun ini yang dikelompokkan:
    // nama script akun lain tidak ikut dikirim, jadi hasilnya memang tidak ada.
    const rawThreshold = String($("accountQuotaThreshold")?.value ?? "").trim();
    const threshold = saveAccountQuotaThreshold(rawThreshold || readAccountQuotaThreshold());
    const results = (data.results && typeof data.results === "object") ? data.results : {};
    const groups = groupUsageByAccount(picked.workers, results, accountId);
    const accounts = {};
    const attributed = new Set();
    let blockedWorkers = 0;

    for (const group of groups.values()) {
      const gate = quotaGate({ used: group.used, quota: quota, threshold: threshold });
      accounts[group.accountId] = {
        used: group.used,
        errors: group.errors,
        percent: gate.percent,
        remaining: gate.remaining,
        level: gate.level,
        blocked: gate.blocked,
        workers: group.workers.map((worker) => {
          if (worker.id) attributed.add(worker.id);
          const row = results[String(worker.name || "").trim()] || {};
          return {
            id: worker.id,
            name: worker.name,
            used: Number(row.requests) || 0,
            errors: Number(row.errors) || 0,
          };
        }),
      };
      if (gate.blocked) blockedWorkers += accounts[group.accountId].workers.length;
    }

    const unattributed = picked.workers
      .filter((worker) => !attributed.has(worker.id))
      .map((worker) => worker.name);

    localStorage.setItem(
      ACCOUNT_QUOTA_GATE_KEY,
      JSON.stringify({
        v: 1,
        day: utcDayKey(Date.now()),
        savedAt: Date.now(),
        quota: quota,
        threshold: threshold,
        accounts: accounts,
        unattributed: unattributed,
      })
    );
    refreshQuotaGateState();
    renderTodayQuota(quotaGateState.snapshot);
    renderQuotaGateStatus();
    // Kartu worker ikut disegarkan dari simpanan gate di atas — TANPA probe /health baru, supaya
    // memuat kuota tidak menambah request yang justru sedang dijaga.
    renderWorkers({ probe: false });

    const notes = [];
    if (blockedWorkers) notes.push(`${blockedWorkers} worker diblokir gate (akun ≥ ${threshold}%)`);
    if (picked.skipped.length) notes.push(`dilewati (bukan nama script Cloudflare): ${picked.skipped.join(", ")}`);
    if (picked.truncated) notes.push(`${picked.truncated} worker lain tidak dihitung (maks ${QUOTA_MAX_SCRIPTS} per permintaan)`);
    if (picked.excluded) notes.push(`${picked.excluded} worker milik akun lain tidak dihitung (muat kuota untuk akun itu)`);
    setMessage(
      "quotaFetchedAt",
      `Terakhir diambil ${new Date().toLocaleTimeString("id-ID")} · jendela ${data.from} s/d ${data.to} UTC${notes.length ? " · " + notes.join(" · ") : ""}`
    );
    setMessage("quotaMessage", "");
  } catch (error) {
    if ($("quotaTable")) $("quotaTable").innerHTML = "";
    refreshQuotaGateState();
    renderQuotaGateStatus();
    renderWorkers({ probe: false });
    setMessage("quotaMessage", (error && error.message) || "Kuota gagal diambil.", true);
  } finally {
    if (button) button.disabled = wasDisabled;
  }
}

// initQuotaPanel mengisi isian kuota dari localStorage dan memasang tombol "Muat ulang". Panel
// sengaja tidak memanggil API sendiri saat halaman dibuka: kredensial bisa belum diisi dan jatah
// statistik (10 permintaan/10 menit) tidak dibuang untuk permintaan yang tidak diminta.
function initQuotaPanel() {
  const input = $("workerDailyQuota");
  if (!input) return;
  if (!input.value || input.value === "100000") input.value = String(readWorkerDailyQuota());
  input.onchange = () => {
    input.value = String(saveWorkerDailyQuota(input.value));
  };
  const thresholdInput = $("accountQuotaThreshold");
  if (thresholdInput) {
    // Isian selalu diisi dari localStorage supaya ambang tersimpan (mis. 75) tidak tertutup
    // nilai bawaan yang tertulis di HTML.
    thresholdInput.value = String(readAccountQuotaThreshold());
    thresholdInput.onchange = () => {
      thresholdInput.value = String(saveAccountQuotaThreshold(thresholdInput.value));
    };
  }
  const reload = $("reloadQuota");
  if (reload) reload.onclick = () => loadTodayQuota(reload);
  // Simpanan gate hari ini ditampilkan tanpa memanggil API: angka terakhir tetap kelihatan
  // (beserta jam pengambilannya) dan status gate sudah jujur sebelum ada permintaan baru.
  refreshQuotaGateState();
  if (quotaGateState.snapshot) renderTodayQuota(quotaGateState.snapshot);
  renderQuotaGateStatus();
}

// renderWorkers menggambar kartu worker. `options.probe === false` melewati pemeriksaan /health
// otomatis — dipakai saat daftar disegarkan dari simpanan kuota (memuat kuota tidak boleh menambah
// request yang justru sedang dijaga) dan saat gate baru saja berubah.
function renderWorkers(options = {}) {
  if (!$("workerList")) return;
  refreshQuotaGateState();
  renderQuotaGateStatus();
  $("emptyWorkers").hidden = state.workers.length > 0;

  const vpnWorkers = state.workers.filter(w => w.type === "vpn");
  const lbWorkers = state.workers.filter(w => w.type === "load_balancer");

  const cardHtml = (worker) => {
    // Penanda gate: worker dari akun yang mencapai ambang disembunyikan dari penawaran config
    // baru dan tidak dipakai untuk copy URL langganan baru — tetap tampil di sini (dengan badge
    // merah) supaya pemiliknya tahu alasannya, dan TIDAK dinonaktifkan di Cloudflare.
    const block = quotaBlockOf(worker);
    const badge = quotaBadgeHtml(worker);
    let extra = "";
    if (worker.type === "load_balancer") {
      const domains = worker.vpn_domains || [];
      const subUrl = withSubToken(`${worker.host}/api/v1/sub?format=raw&limit=20${domains.length ? "&domains=" + domains.join(",") : ""}`, worker.sub_token);
      // Token langganan hanya dipasang ke worker oleh deploy (batch "Deploy ulang semua"),
      // halaman ini tidak menyimpan kredensial Cloudflare.
      const tokenNote = worker.sub_token
        ? "Token langganan tersimpan. \"Ganti token\" membuat token baru; tautan lama baru mati setelah deploy ulang di halaman Deploy."
        : "Belum ada token langganan tersimpan — URL di atas masih terbuka tanpa token. \"Ganti token\" membuatnya.";
      // Copy URL langganan = membuat tautan baru untuk dibagikan, jadi tombolnya dimatikan saat
      // akun worker ini mencapai ambang kuota (kontrak gate: berhenti menawarkan config baru).
      const subRow = block
        ? `<div class="sub-row"><code class="sub-url">${escapeHtml(subUrl)}</code><span class="form-message" style="min-height:0;color:#fca5a5">Kuota akun ${block.percent}% — tombol Copy dimatikan untuk URL langganan baru sampai pemakaian turun.</span></div>`
        : `<div class="sub-row"><code class="sub-url">${escapeHtml(subUrl)}</code><button class="icon-button" data-copy-sub="${escapeHtml(subUrl)}" type="button">Copy</button></div>`;
      extra = `<div class="lb-details"><div class="lb-domains"><span class="eyebrow">VPN Worker terhubung</span><code>${domains.length ? escapeHtml(domains.join(", ")) : "<i>Belum ada</i>"}</code></div><div class="lb-sub"><span class="eyebrow">URL Subscription</span>${subRow}</div><div class="form-actions" style="margin-top:8px"><button class="icon-button" data-rotate-sub="${worker.id}" type="button">Ganti token</button><button class="icon-button" data-edit-lb="${worker.id}" type="button">Edit VPN Domains</button></div><p class="form-message" style="min-height:0">${tokenNote}</p></div>`;
    }

    const usage = worker.type === "vpn" && !block ? `<a class="icon-button" href="generator.html?worker=${worker.id}">Pakai</a>` : "";

    // Tombol "Statistik" sengaja TIDAK ditaruh di baris .worker-meta: input sakelar aktif
    // (position:absolute, opacity:0) menutupi tombol di belakangnya sehingga kliknya tidak sampai
    // (terbukti menggagalkan klik "Hapus"). Input itu kini diberi pointer-events:none — label tetap
    // men-toggle kontrolnya, sedangkan tombol di sebelahnya bisa diklik lagi. Baris aksi tombol
    // Statistik tetap punya barisnya sendiri di bawah kartu.
    return `<article class="worker-card worker-card-lb"><div class="worker-card-head"><div><p class="worker-title">${escapeHtml(worker.name)}</p><code>${escapeHtml(worker.host)}</code>${badge ? `<div style="margin-top:6px">${badge}</div>` : ""}</div><div class="worker-meta"><span class="type">${typeLabel(worker.type)}</span><label class="switch"><input data-toggle="${worker.id}" type="checkbox" ${worker.active ? "checked" : ""} style="pointer-events:none"><span></span><b>${worker.active ? "Aktif" : "Nonaktif"}</b></label>${usage}<button class="icon-button danger" data-delete="${worker.id}" type="button">Hapus</button></div></div>${extra}<div class="health" data-health="${worker.id}" style="margin-top:10px">${healthBlockHtml(worker)}</div><div style="margin-top:8px"><button class="icon-button" data-stats="${worker.id}" type="button">Statistik</button></div><p class="form-message" id="stats-${worker.id}" aria-live="polite"></p></article>`;
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

  // Pemeriksaan otomatis untuk SEMUA worker aktif (bukan hanya VPN): yang dinilai adalah worker
  // menjawab atau tidak. Versi dibandingkan dengan template JENISNYA sendiri (VPN ↔
  // WORKER_TEMPLATE_VERSION, Load Balancer ↔ LB_TEMPLATE_VERSION) lewat versionStateFromHealth,
  // jadi kartu LB tidak pernah dituduh "versi lama" karena beda dengan versi VPN. Template lama
  // yang belum membalas `type`/`version` tetap tampil "versi tidak diketahui".
  // `options.probe === false` (penyegaran dari simpanan kuota) tidak memanggil /health sama sekali.
  if (options.probe !== false) checkWorkerHealth(state.workers);

  const checkAllButton = $("checkAllHealth");
  if (checkAllButton) checkAllButton.onclick = checkAllWorkerHealth;

  initQuotaPanel();

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
    const host = $("workerHost").value.trim().replace(/^https?:\/\//i, "").replace(/[/?:#].*$/, "").toLowerCase();
    if (!validHost(host)) return alert("Domain Worker tidak valid.");
    const type = $("workerType").value;
    const editId = form.dataset.editId;
    if (editId) {
      const w = state.workers.find(w => w.id === editId);
      if (!w) return;
      w.name = $("workerName").value.trim();
      w.host = host;
      w.type = type;
      if (type === "load_balancer") {
        const domains = $("workerVpnDomains").value.trim();
        w.vpn_domains = domains ? domains.split(",").map(d => d.trim().replace(/^https?:\/\//i, "").replace(/[/?:#].*$/, "").toLowerCase()).filter(Boolean) : [];
      } else {
        delete w.vpn_domains;
      }
      delete form.dataset.editId;
    } else {
      const worker = { id: crypto.randomUUID(), name: $("workerName").value.trim(), host, type, active: true };
      if (type === "load_balancer") {
        const domains = $("workerVpnDomains").value.trim();
        worker.vpn_domains = domains ? domains.split(",").map(d => d.trim().replace(/^https?:\/\//i, "").replace(/[/?:#].*$/, "").toLowerCase()).filter(Boolean) : [];
      }
      state.workers.push(worker);
    }
    saveState();
    form.reset();
    form.hidden = true;
    $("vpnDomainsField").hidden = true;
    form.querySelector("button[type=submit]").textContent = "Simpan Worker";
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
    const statsId = event.target.dataset.stats;
    if (statsId) {
      const worker = state.workers.find(w => w.id === statsId);
      if (worker) showWorkerStats(worker, event.target);
      return;
    }
    const editLb = event.target.dataset.editLb;
    if (editLb) {
      const worker = state.workers.find(w => w.id === editLb);
      if (!worker) return;
      const form = $("addWorkerForm");
      $("workerName").value = worker.name;
      $("workerHost").value = worker.host;
      $("workerType").value = worker.type;
      $("vpnDomainsField").hidden = worker.type !== "load_balancer";
      $("workerVpnDomains").value = (worker.vpn_domains || []).join(", ");
      form.hidden = false;
      form.dataset.editId = editLb;
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

async function loadProxyPickerData() {
  if (_proxyPickerCache) return _proxyPickerCache;
  const CACHE_KEY = "proxyPickerCache";
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && cached.v === 3 && (Date.now() - cached.ts) < CACHE_TTL) {
      _proxyPickerCache = cached.data;
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
      proxies = rows.map((p) => ({
        ip: p.ip,
        port: String(p.port),
        country: p.country || "",
        org: p.org || "",
        checked: p.last_checked || "",
        ping: Number(p.ping) || 0,
        tunnel: typeof p.tunnel_ok === "boolean" ? p.tunnel_ok : null,
        tunnelMs: Number(p.tunnel_ms) || 0,
        // Bukti dari vantage host (mesin scanner). `tls_ok` (kolom lama) dan `tunnel_host_ok`
        // (kolom baru) sama-sama tulisan panproxyscanner; hanya nilai true yang jadi bukti.
        hostTunnel: p.tunnel_host_ok === true,
        hostTunnelMs: Number(p.tunnel_host_ms) || 0,
        tls: p.tls_ok === true,
      }));
    }
  }
  // No local fallback — only use Supabase
  if (!proxies.length) return [];
  proxies = proxies.map(p => ({ ...p, country: p.country || "??", org: p.org || "Unknown" }));
  _proxyPickerCache = proxies;
  localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 3, data: proxies, ts: Date.now() }));
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

// renderGeneratorGateNote menyatakan status gate di halaman Generator. Gate yang tidak aktif TIDAK
// berarti "semua aman" — artinya panel belum punya data pemakaian hari ini, dan pesannya menyebut
// itu supaya tidak ada rasa aman palsu.
function renderGeneratorGateNote(hiddenNames) {
  const el = $("quotaGateNote");
  if (!el) return;
  if (!quotaGateState.snapshot) {
    el.textContent =
      "Gate kuota akun tidak aktif: pemakaian hari ini belum dimuat (buka Workers → \u201cMuat ulang\u201d kuota), jadi semua worker tetap ditawarkan.";
    el.classList.add("error");
    return;
  }
  const threshold = quotaGateState.threshold;
  el.classList.toggle("error", hiddenNames.length > 0);
  el.textContent = hiddenNames.length
    ? `Kuota akun mencapai ambang ${threshold}%: ${hiddenNames.join(", ")} tidak ditawarkan untuk config/subscription baru (worker tetap aktif di Cloudflare).`
    : `Gate kuota akun aktif (ambang ${threshold}%): semua worker masih di bawah ambang.`;
}

function renderGenerator() {
  if (!$("generatorForm")) return;
  const workerSelect = $("workerSelect");
  const lbSelect = $("lbSelect");
  const modeSelect = $("modeSelect");
  const wanted = new URLSearchParams(location.search).get("worker");

  // Gate kuota akun: worker dari akun yang mencapai ambang TIDAK ditawarkan sebagai pilihan
  // worker/LB baru (termasuk tautan ?worker=<id> dari kartu "Pakai"), dan URL langganan baru
  // tidak dibuat darinya. Simpanan gate dibaca ulang supaya keputusan mengikuti data terakhir.
  refreshQuotaGateState();
  const gatedNames = [];
  const selectable = (type) => activeWorkers(type).filter((worker) => {
    if (!quotaBlockOf(worker)) return true;
    gatedNames.push(worker.name);
    return false;
  });
  const vpnChoices = selectable("vpn");

  workerSelect.innerHTML = `<option value="">Pilih VPN Worker</option>${vpnChoices.map(w => `<option value="${w.id}">${escapeHtml(w.name)} · ${escapeHtml(w.host)}</option>`).join("")}`;
  if (wanted && [...workerSelect.options].some(o => o.value === wanted)) workerSelect.value = wanted;

  const lbWorkers = selectable("load_balancer");
  lbSelect.innerHTML = `<option value="">Pilih Load Balancer</option>${lbWorkers.map(w => `<option value="${w.id}">${escapeHtml(w.name)} · ${escapeHtml(w.host)}</option>`).join("")}`;
  renderGeneratorGateNote(gatedNames);

  let allProxies = [];
  const countrySelect = $("countrySelect");
  const orgSelect = $("orgSelect");
  const proxySelect = $("proxySelect");

  // Multi-pilih: tidak ada opsi "semua negara" — tidak memilih apa pun berarti semua negara.
  const selectedCountries = () => [...countrySelect.selectedOptions].map(o => o.value).filter(Boolean);
  const populateCountries = () => {
    const countries = [...new Set(allProxies.map(p => p.country))].filter(c => c && c !== "??").sort();
    countrySelect.innerHTML = countries.map(c => {
      const fresh = proxyHealth(allProxies, [c]).fresh;
      return `<option value="${c}">${getFlagEmoji(c)} ${c} · ${fresh} segar</option>`;
    }).join("");
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
    const cc = selectedCountries();
    if (!cc.length) {
      const all = proxyHealth(allProxies, []);
      const sources = evidenceBreakdown(all);
      el.textContent = `${all.fresh} proxy segar di semua negara (${all.usable.length} siap dipakai).`
        + (sources.length ? " " + sources.join(" · ") + "." : "");
      el.classList.remove("error");
      return;
    }
    const h = proxyHealth(allProxies, cc);
    const flag = cc.map(c => `${getFlagEmoji(c)} ${c}`).join(" + ");
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
    if (!h.usable.length) text += " — kemungkinan gagal: tidak ada proxy siap pakai, pakai /ALL atau negara lain.";
    if (h.verified.length) text += " · tercepat " + (proxyEvidence(h.verified[0]).ms || h.verified[0].ping) + " ms";
    el.textContent = text;
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

  (async () => {
    try {
      setMessage("formMessage", "Memuat daftar proxy...");
      allProxies = await loadProxyPickerData();
      populateCountries();
      populateOrgs();
      populateProxies();
      updateCountryStats();
      setMessage("formMessage", `${allProxies.length} proxy aktif tersedia.`);
    } catch (e) {
      setMessage("formMessage", "Gagal memuat proxy: " + e.message, true);
    }
  })();

  const selectedWorker = () => state.workers.find(w => w.id === workerSelect.value && w.type === "vpn");
  const selectedLb = () => state.workers.find(w => w.id === lbSelect.value && w.type === "load_balancer");

  modeSelect.onchange = () => {
    const isSub = modeSelect.value === "subscription";
    $("localMode").hidden = isSub;
    $("subMode").hidden = !isSub;
    updatePreview();
  };

  countrySelect.onchange = () => { populateOrgs(); populateProxies(); updateCountryStats(); updatePreview(); };
  $("rotateMode")?.addEventListener("change", () => updatePreview());
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
      const org = orgSelect.value;
      const specific = proxySelect.value;
      const lim = $("limitInput").value;
      const rotate = $("rotateMode")?.checked === true;
      let info = `${worker.host} · ${lim} config`;
      if (specific) info += ` · ${specific}`;
      else if (cc.length) info += ` · ${cc.map(c => `${getFlagEmoji(c)} ${c}`).join("+")}`;
      else info += ` · semua negara`;
      if (org) info += ` · ${org}`;
      if (!worker.uuid) info += " · ⚠ UUID belum terikat (deploy ulang dari panel)";
      if (rotate) info += ` · path ${cc.length ? "/" + cc.join(",") : "/ALL"}`;
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
        // Pagar terakhir gate: pilihan yang diblokir sudah tidak ada di daftar, tapi nilai select
        // bisa diisi lewat console — URL langganan baru tetap tidak dibuat untuk akun yang
        // kuotanya mencapai ambang.
        const lbBlock = quotaBlockOf(lb);
        if (lbBlock) {
          return setMessage("formMessage", `Kuota akun ${lbBlock.percent}% — ${lb.name} berhenti menawarkan URL langganan baru sampai pemakaian turun.`, true);
        }
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
        const workerBlock = quotaBlockOf(worker);
        if (workerBlock) {
          return setMessage("formMessage", `Kuota akun ${workerBlock.percent}% — ${worker.name} berhenti menawarkan config baru sampai pemakaian turun.`, true);
        }
        // Worker yang di-deploy panel mengunci UUID lewat binding UUID_ALLOWLIST. Kalau state
        // tidak menyimpan UUID-nya (worker lama / ditambah manual), config hasil generate akan
        // membawa UUID acak yang pasti ditolak worker — lebih baik ditolak di sini dengan pesan
        // jelas daripada user bingung kenapa "tersambung lalu putus".
        if (!worker.uuid) {
          return setMessage("formMessage", "Worker ini belum punya UUID terikat. Deploy ulang worker dari halaman Deploy supaya UUID-nya tercatat, lalu generate lagi (atau pakai config lama yang masih memakai UUID tersebut).", true);
        }
        const ccList = selectedCountries();
        const orgValue = orgSelect.value;
        const rotate = $("rotateMode")?.checked === true;
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
          insecure: $("insecureTls")?.checked === true,
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
  const credentialsReady = () => Boolean(
    $("cfApiKey")?.value.trim() && $("cfEmail")?.value.trim() && $("cfAccountId")?.value.trim()
  );

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
    if (!cfApiKey || !cfEmail || !accountId) {
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
        return `<tr><td><code>${escapeHtml(u.username)}</code></td><td>${isAdmin ? '<span class="proxy-status live">admin</span>' : '<span class="proxy-status dead">user</span>'}</td><td>${toggleBtn}${delBtn}</td></tr>`;
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


async function init() {
  const authOk = await checkAuth();
  if (authOk) {
    await loadState();
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




// Ganti proxy manager script yg lama jadi logic Supabase
function renderProxyManager() {
  if (!document.getElementById('dbProxyForm')) return;

  let currentList = [];
  let viewMode = 'live';

  const CACHE_KEY = "proxyListCache";
  const CACHE_TTL = 6 * 60 * 60 * 1000;

  const fmtDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const renderTable = () => {
    const list = currentList.filter(p => viewMode === 'live' ? p.is_active : !p.is_active);
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
      return `<tr><td><code>${escapeHtml(p.ip)}:${escapeHtml(p.port)}</code></td><td>${flag} ${escapeHtml(p.country || '—')}</td><td>${escapeHtml(p.org || '—')}</td><td>${status}</td><td>${fmtDate(p.last_checked)}</td></tr>`;
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


