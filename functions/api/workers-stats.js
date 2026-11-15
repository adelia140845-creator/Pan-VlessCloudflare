// Statistik pemakaian Worker dari Cloudflare GraphQL analytics.
// POST /api/workers-stats with { cfEmail, cfApiKey, accountId, scriptName, hours? }
//
// Halaman Workers memakainya untuk tombol "Statistik" di kartu worker. API analitik Cloudflare
// TIDAK bisa dipanggil langsung dari browser (tanpa CORS), jadi permintaannya lewat route ini.
//
// Pagarnya sama dengan /api/cf (lihat functions/api/cf.js): gerbang Origin opsional, rate limit
// Cache API per IP, lalu batas global lewat RPC bump_rate. Jatahnya SENDAKIRI dipisah dari
// /api/cf (nama env RATE_LIMIT_STATS/RATE_WINDOW_SEC_STATS + keyOrigin sendiri + scope "stats")
// supaya membuka statistik tidak memakan kuota deploy.
//
// Angka yang ditampilkan selalu berasal dari jawaban Cloudflare. Kalau Cloudflare menolak, route
// ini meneruskan alasan aslinya (dan menyebut izin yang dibutuhkan kalau penolakannya soal
// scope) — tidak pernah mengarang 0 permintaan/0 error.
import {
  readHeader,
  clientIp,
  parseOrigins,
  originAllowed,
  readEnvInt,
  checkRateLimit,
  checkGlobalRateLimit,
} from "./lib/rate-limit.js";

export { readHeader, clientIp, parseOrigins, originAllowed, readEnvInt, checkRateLimit };

// Endpoint GraphQL analitik Cloudflare (satu endpoint untuk semua dataset analitik).
export const STATS_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
// Jendela bawaan 24 jam, batas atas 720 jam (30 hari) supaya satu permintaan tidak menarik
// riwayat yang sangat panjang.
export const STATS_DEFAULT_HOURS = 24;
export const STATS_MAX_HOURS = 720;
// Izin yang dibutuhkan API token Cloudflare untuk dataset ini. Disebut apa adanya di pesan
// penolakan supaya pengguna tahu apa yang harus ditambahkan ke token-nya.
export const ANALYTICS_SCOPE_HINT = "Account Analytics: Read";
// Nama script Cloudflare: huruf kecil/angka/garis bawah/strip, diawali huruf atau angka.
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
// Kunci rate limit sendiri, terpisah dari /api/cf.
const STATS_RATE_LIMIT_KEY = "https://cfvpn-hub-rate-limit.invalid/api/workers-stats";

// statsWindowHours menormalkan jendela jam: angka bulat 1..STATS_MAX_HOURS, nilai kosong/aneh
// (termasuk 0 dan negatif) kembali ke 24 jam.
export function statsWindowHours(value) {
  if (value === undefined || value === null || value === "") return STATS_DEFAULT_HOURS;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return STATS_DEFAULT_HOURS;
  return Math.min(parsed, STATS_MAX_HOURS);
}

// buildInvocationsQuery menyusun body GraphQL untuk dataset workersInvocationsAdaptive:
// `{ query, variables, hours, since, until }`. Nama script dan account TIDAK pernah disisipkan ke
// teks query (itu celah injeksi); keduanya dikirim sebagai variabel, jadi JSON.stringify(body)
// yang meng-escape-nya. Jendela waktunya inklusif (`datetime_geq`/`datetime_leq`).
export function buildInvocationsQuery(options) {
  const opts = options && typeof options === "object" ? options : {};
  const hours = statsWindowHours(opts.hours);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const since = new Date(nowMs - hours * 3600 * 1000).toISOString();
  const until = new Date(nowMs).toISOString();

  return {
    query: [
      "query WorkerInvocations($accountTag: string!, $scriptName: string!, $since: Time!, $until: Time!) {",
      "  viewer {",
      "    accounts(filter: { accountTag: $accountTag }) {",
      "      workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }) {",
      "        sum { requests errors }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: {
      accountTag: String(opts.accountId ?? "").trim(),
      scriptName: String(opts.scriptName ?? "").trim(),
      since: since,
      until: until,
    },
    hours: hours,
    since: since,
    until: until,
  };
}

// readInvocationsTotals menjumlahkan baris workersInvocationsAdaptive. `null` dikembalikan kalau
// bentuk balasannya tidak dikenal (data kosong/error) supaya pemanggil membalas kesalahan, bukan
// menampilkan 0 — angka 0 yang salah lebih menyesatkan daripada pesan gagal.
export function readInvocationsTotals(payload) {
  const accounts = payload && payload.data && payload.data.viewer ? payload.data.viewer.accounts : null;
  if (!Array.isArray(accounts) || !accounts.length) return null;
  const groups = accounts[0] ? accounts[0].workersInvocationsAdaptive : null;
  if (!Array.isArray(groups)) return null;

  let requests = 0;
  let errors = 0;
  for (const group of groups) {
    requests += Number(group && group.sum ? group.sum.requests : 0) || 0;
    errors += Number(group && group.sum ? group.sum.errors : 0) || 0;
  }
  return { requests: requests, errors: errors, groups: groups.length };
}

// cloudflareStatsError menerjemahkan penolakan Cloudflare (HTTP bukan 2xx atau `errors` GraphQL)
// jadi status + pesan untuk klien:
//   - 403 / pesan soal izin-otorisasi -> 403 dan pesan menyebut ANALYTICS_SCOPE_HINT,
//   - gangguan di sisi Cloudflare (5xx) -> 502,
//   - sisanya -> status balasan Cloudflare apa adanya (>=400) atau 400.
export function cloudflareStatsError(httpStatus, payload) {
  const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors.find((item) => item && typeof item.message === "string" && item.message.trim());
  const raw = String(
    (first && first.message) || (payload && typeof payload.error === "string" ? payload.error : "")
  ).trim();
  const status = Number.isFinite(httpStatus) ? Math.trunc(httpStatus) : 0;
  const needsScope = status === 403 ||
    /permission|forbidden|not authorized|not authorised|unauthori[sz]ed|scope|analytics: read/i.test(raw);

  let replyStatus;
  if (needsScope) replyStatus = 403;
  else if (status >= 500) replyStatus = 502;
  else if (status >= 400) replyStatus = status;
  else replyStatus = 400;

  const detail = raw || `Cloudflare menolak permintaan statistik (HTTP ${status || "?"}).`;
  const message = needsScope
    ? `${detail} Tambahkan izin "${ANALYTICS_SCOPE_HINT}" pada API token Cloudflare yang dipakai (atau pakai Global API Key akun yang boleh membaca analitik).`
    : detail;

  return { status: replyStatus, message: message, needsScope: needsScope, cloudflareMessage: raw || null };
}

export async function onRequest(context) {
  const request = context.request;

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    // Gerbang Origin opsional (env ALLOWED_ORIGINS), sama seperti /api/cf.
    const allowedOrigins = parseOrigins(context.env?.ALLOWED_ORIGINS);
    if (!originAllowed(readHeader(request.headers, "Origin"), allowedOrigins)) {
      return jsonResponse({ error: "Origin tidak diizinkan." }, 403);
    }

    const gate = await checkRateLimit(context.env, request, {
      limitEnv: "RATE_LIMIT_STATS",
      windowEnv: "RATE_WINDOW_SEC_STATS",
      keyOrigin: STATS_RATE_LIMIT_KEY,
    });
    if (gate.limited) {
      return jsonResponse(
        { error: "Terlalu banyak permintaan. Coba lagi dalam " + gate.retryAfter + " detik." },
        429,
        { "Retry-After": String(gate.retryAfter) }
      );
    }

    const globalGate = await checkGlobalRateLimit(context.env, request, {
      scope: "stats",
      limit: gate.limit,
      windowSec: gate.windowSec,
      ip: gate.ip,
    });
    if (globalGate.limited) {
      return jsonResponse(
        { error: "Terlalu banyak permintaan. Coba lagi dalam " + globalGate.retryAfter + " detik." },
        429,
        { "Retry-After": String(globalGate.retryAfter) }
      );
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return jsonResponse({ error: "Body JSON tidak valid." }, 400);
    }

    const cfEmail = trimField(data && data.cfEmail);
    const cfApiKey = trimField(data && data.cfApiKey);
    const accountId = trimField(data && data.accountId);
    const scriptName = trimField(data && data.scriptName);

    if (!cfEmail || !cfApiKey || !accountId || !scriptName) {
      return jsonResponse({ error: "Data Cloudflare tidak lengkap." }, 400);
    }
    if (!SCRIPT_NAME.test(scriptName)) {
      return jsonResponse(
        {
          error: `Nama script tidak valid: "${scriptName}". Cloudflare hanya menerima huruf kecil, angka, "-" dan "_" (mis. cfvpn-vpn-sg).`,
        },
        400
      );
    }

    const built = buildInvocationsQuery({
      accountId: accountId,
      scriptName: scriptName,
      hours: data && data.hours,
    });

    const response = await fetch(STATS_ENDPOINT, {
      method: "POST",
      headers: {
        "X-Auth-Email": cfEmail,
        "X-Auth-Key": cfApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: built.query, variables: built.variables }),
    });

    const payload = await response.json().catch(() => null);
    const graphErrors = payload && Array.isArray(payload.errors) ? payload.errors : [];
    if (!response.ok || graphErrors.length) {
      const failure = cloudflareStatsError(response.status, payload);
      return jsonResponse({ error: failure.message, needsScope: failure.needsScope }, failure.status);
    }

    const totals = readInvocationsTotals(payload);
    if (!totals) {
      return jsonResponse(
        { error: "Balasan Cloudflare tidak memuat data workersInvocationsAdaptive." },
        400
      );
    }

    return jsonResponse(
      { success: true, requests: totals.requests, errors: totals.errors, hours: built.hours },
      200
    );
  } catch (error) {
    return jsonResponse({ error: (error && error.message) || "Gagal mengambil statistik." }, 500);
  }
}

function trimField(value) {
  return typeof value === "string" ? value.trim() : "";
}

// jsonResponse menyusun balasan JSON route ini (header tambahan, mis. Retry-After).
function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}
