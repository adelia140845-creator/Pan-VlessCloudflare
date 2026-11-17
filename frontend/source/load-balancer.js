// Load Balancer & Subscription Worker for Pan-VlessCloudflare
// Mengambil proxy hidup dari Supabase (berdasarkan Ping terbaik) dan merakit config VLESS
//
// Endpoint: /api/v1/sub (langganan; wajib membawa ?t=<token> kalau binding SUB_TOKEN diisi) dan
// /health (status + versi template; selalu terbuka, tidak ikut gerbang token).

// Pemilihan proxy memakai tingkat bukti yang sama dengan worker VPN: verdict EDGE (tunnel_ok, diisi
// cron-worker) > bukti host TLS (tls_ok) > bukti tunnel host scanner (tunnel_host_ok) > ping.
// Baris yang di edge TERBUKTI MATI (tunnel_ok = false) tidak ikut sama sekali: worker VLESS
// berjalan di edge, jadi vonis edge yang menentukan (pengukuran 15 Nov: 87 dari 276 baris aktif).
const SUPABASE_BASE = "https://lumbbmhhmkcnxunuryjr.supabase.co/rest/v1/proxy_pool?select=*&is_active=eq.true";
const SUPABASE_URL = SUPABASE_BASE +
  "&or=(tunnel_ok.is.null,tunnel_ok.eq.true)" +
  "&order=tunnel_ok.desc.nullslast,tls_ok.desc.nullslast,tunnel_host_ok.desc.nullslast,ping.asc.nullslast";
// Cadangan kalau kolom bukti belum ada di tabel (migrasi belum dijalankan): urut ping saja.
const SUPABASE_URL_FALLBACK = SUPABASE_BASE + "&order=ping.asc.nullslast";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx1bWJibWhobWtjbnh1bnVyeWpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0NzI1MjEsImV4cCI6MjExMDA0ODUyMX0.ylMqMgv2H4vWax-whnXSRHBlD7DZs9DXVRUD9fAO6mc";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Versi template Load Balancer. Dibalas /health supaya panel bisa menandai LB yang masih memakai
// template lama; pasangannya adalah LB_TEMPLATE_VERSION di frontend/app.js — keduanya naik
// bersama-sama, sama seperti pasangan WORKER_VERSION/WORKER_TEMPLATE_VERSION di template VPN.
const LB_VERSION = "2026-11-17c";

// --- Token langganan ---------------------------------------------------------

// Kalau binding SUB_TOKEN diisi (dikirim panel saat deploy), /api/v1/sub wajib membawa
// t=<token> (token= juga diterima). Tanpa binding itu LB tetap terbuka seperti sebelum fitur
// ini: worker yang sudah ter-deploy tidak boleh mati hanya karena panelnya belum dikirim binding.
export function subTokenStatus(url, envToken) {
  const expected = typeof envToken === "string" ? envToken.trim() : "";
  if (!expected) return 200;
  const provided = url.searchParams.get("t") ?? url.searchParams.get("token") ?? "";
  return provided === expected ? 200 : 403;
}

// --- Cache pool --------------------------------------------------------------

// Hasil tarikan proxy_pool di-cache 60 detik lewat Cache API: satu tarikan Supabase melayani
// semua permintaan langganan di jendela itu. Alasannya kuota Worker (subrequest per permintaan
// ikut terpotong, daftar proxy berubah lambat) dan latensi Supabase. Kegagalan cache — mis. di
// `wrangler dev` atau saat put ditolak — TIDAK boleh menggagalkan langganan: kalau cache tidak
// bisa dipakai, kita jatuh ke fetch langsung.
const CACHE_TTL_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // /health: status dasar Worker LB (versi template + jenis worker). SENGAJA TANPA gerbang
    // SUB_TOKEN — gerbang itu hanya milik /api/v1/sub — supaya panel bisa memeriksa worker ini
    // hidup atau tidak dan menandai LB yang masih versi lama tanpa perlu tahu token langganan.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, type: "load_balancer", version: LB_VERSION }), {
        status: 200,
        headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS),
      });
    }

    if (url.pathname.startsWith("/api/v1/sub")) {
      const status = subTokenStatus(url, env.SUB_TOKEN);
      if (status !== 200) {
        return new Response("Token langganan tidak valid. Sertakan ?t=<token>.", {
          status,
          headers: CORS_HEADERS,
        });
      }
      return await generateSubscription(url, env, ctx);
    }

    return new Response("Pan-VlessCloudflare Subscription API. Use /api/v1/sub", { status: 200 });
  },
};

// Ambil baris proxy: pakai cache dulu, isi cache kalau kosong (lihat CACHE_TTL_SECONDS).
async function getLiveProxies(ctx) {
  const cache = typeof caches !== "undefined" && caches ? caches.default : null;
  const cacheKey = new Request(SUPABASE_URL);

  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return await hit.json();
    } catch (e) {}
  }

  const rows = await fetchLiveProxies();

  // Baris kosong (tarikan Supabase gagal) sengaja TIDAK ikut di-cache: gangguan sesaat jangan
  // terkunci 60 detik di semua langganan.
  if (cache && ctx && typeof ctx.waitUntil === "function" && Array.isArray(rows) && rows.length) {
    try {
      // waitUntil: penulisan cache tidak menahan balasan langganan (tidak menambah latensi).
      ctx.waitUntil(
        cache
          .put(
            cacheKey,
            new Response(JSON.stringify(rows), {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
              },
            })
          )
          .catch(() => {})
      );
    } catch (e) {}
  }

  return rows;
}

async function fetchLiveProxies() {
  try {
    const headers = { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` };
    let response = await fetch(SUPABASE_URL, { headers });
    if (!response.ok) {
      // Kolom bukti belum ada (migrasi belum jalan) -> pakai urutan lama supaya langganan tetap hidup.
      response = await fetch(SUPABASE_URL_FALLBACK, { headers });
    }
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {}
  return [];
}

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

async function generateSubscription(url, env, ctx) {
  const filterCC = url.searchParams.get("cc")?.toUpperCase().split(",") || [];
  const filterPort = url.searchParams.get("port")?.split(",") || ["443", "80"];
  const filterLimit = parseInt(url.searchParams.get("limit")) || 20;
  const format = url.searchParams.get("format") || "raw";

  // Satu jenis worker VPN saja: tidak ada lagi pemisahan Free/Premium.
  // Daftar host worker datang dari ?domains= (boleh banyak, dipisah koma) atau binding VPN_DOMAINS.
  // Tanpa daftar host, langganan ditolak dengan pesan jelas — lebih baik gagal terbuka daripada
  // merakit config yang menunjuk host yang bukan milik pemiliknya.
  const vpnDomainsParam = url.searchParams.get("domains") || url.searchParams.get("domain") || (env && env.VPN_DOMAINS) || "";
  const domainList = vpnDomainsParam.split(",").map(d => d.trim()).filter(Boolean);
  if (domainList.length === 0) {
    return new Response("Belum ada domain worker VPN. Kirim ?domains=host1,host2 atau isi binding VPN_DOMAINS.", {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let proxyList = await getLiveProxies(ctx);

  if (filterCC.length > 0) {
    proxyList = proxyList.filter(p => filterCC.includes(p.country?.toUpperCase()));
  }

  // SOLUSI TERBAIK:
  // Karena API sudah narik data secara urut bukti lalu ping (lihat SUPABASE_URL),
  // kita ambil (slice) jumlah 2x lipat dari limit permintaan user untuk menjaga kualitas elit.
  const elitPoolSize = filterLimit * 2;
  if (proxyList.length > elitPoolSize) {
    proxyList = proxyList.slice(0, elitPoolSize);
  }

  shuffleArray(proxyList);

  // UUID: bawaan acak per tarikan. Kalau worker dikunci UUID_ALLOWLIST, kirim ?uuid=<uuid worker>
  // supaya config hasil langganan tidak ditolak (worker tidak bisa dibaca dari sini, jadi pemilik
  // langganan yang menentukan).
  const fixedUuid = (url.searchParams.get("uuid") || url.searchParams.get("u") || "").trim();
  const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(fixedUuid)
    ? fixedUuid
    : crypto.randomUUID();
  const result = [];
  let domainIndex = 0;

  outer: for (const prx of proxyList) {
    const ip = prx.ip || "104.17.2.1";
    const proxyPort = prx.port || "443";
    const country = prx.country || "XX";
    const org = prx.org || "Cloud";

    for (const port of filterPort) {
      if (result.length >= filterLimit) break outer;

      const tls = port === "443" || port === "8443";
      const path = `/${ip}-${proxyPort}`;

      const currentVpnDomain = domainList[domainIndex % domainList.length];
      domainIndex++;

      // Tambahkan Label PREM/FREE supaya user tau dia pakai tipe server apa
      const serviceName = currentVpnDomain.split(".")[0].toUpperCase();
      const label = `${result.length + 1} ${getFlagEmoji(country)} ${org} ${tls ? "TLS" : "NTLS"}`;

      const query = new URLSearchParams({
        encryption: "none",
        type: "ws",
        host: currentVpnDomain,
        security: tls ? "tls" : "none",
        sni: tls ? currentVpnDomain : "",
        path: path
      });

      const config = `vless://${uuid}@${currentVpnDomain}:${port}?${query.toString()}#${encodeURIComponent(label)}`;
      result.push(config);
    }
  }

  let finalOutput = result.join("\n");
  let contentType = "text/plain; charset=utf-8";

  if (format === "v2ray" || format === "base64") {
    finalOutput = btoa(finalOutput);
  } else if (format === "clash") {
    const proxies = result.map(c => {
      const u = new URL(c);
      return `  - name: "${decodeURIComponent(u.hash.slice(1))}"
    type: vless
    server: ${u.hostname}
    port: ${u.port}
    uuid: ${u.username}
    udp: true
    tls: ${u.searchParams.get("security") === "tls"}
    network: ws
    servername: ${u.searchParams.get("sni") || u.hostname}
    ws-opts:
      path: "${u.searchParams.get("path") || "/"}"
      headers:
        Host: ${u.searchParams.get("host") || u.hostname}`;
    }).join("\n");
    finalOutput = `proxies:\n${proxies}`;
    contentType = "application/x-yaml; charset=utf-8";
  } else if (format === "sing-box" || format === "singbox") {
    // Bentuk outbound harus identik dengan generateSingboxJson di panel (frontend/app.js) supaya
    // config dari LB dan dari halaman Generator tidak berbeda: tls hanya saat security=tls,
    // insecure hanya dari allowInsecure, transport ws selalu ikut.
    const outbounds = result.map((c) => {
      const u = new URL(c);
      return {
        type: "vless",
        tag: decodeURIComponent(u.hash.slice(1)),
        server: u.hostname,
        server_port: parseInt(u.port, 10),
        uuid: u.username,
        tls: u.searchParams.get("security") === "tls" ? { enabled: true, server_name: u.searchParams.get("sni") || u.hostname, insecure: u.searchParams.get("allowInsecure") === "1" } : undefined,
        transport: { type: "ws", path: u.searchParams.get("path") || "/", headers: { Host: u.searchParams.get("host") || u.hostname } }
      };
    });
    finalOutput = JSON.stringify({ outbounds }, null, 2);
    contentType = "application/json; charset=utf-8";
  }

  return new Response(finalOutput, {
    headers: { ...CORS_HEADERS, "Content-Type": contentType }
  });
}
