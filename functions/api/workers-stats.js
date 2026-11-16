// Statistik pemakaian Worker dari Cloudflare GraphQL analytics.
// POST /api/workers-stats with { cfEmail, cfApiKey, accountId, scriptName, hours? }
//   atau { cfEmail, cfApiKey, accountId, period: "today", scriptNames: string[], dailyQuota? }
//
// Dua mode:
//   - satu script (scriptName + hours) — balasan lama, ditambah period/from/to;
//   - banyak script (scriptNames[], maks 10) — SATU query GraphQL dengan alias `s0`, `s1`, ...
//     karena jatah rate limit statistik cuma 10 permintaan/10 menit: satu halaman = satu request,
//     bukan satu request per worker.
// `period: "today"` memakai jendela 00:00:00Z hari ini sampai sekarang (UTC, sama dengan tanggal
// yang dipakai Cloudflare) dan boleh membawa `dailyQuota` untuk ringkasan kuota harian.
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
// Batas jumlah script dalam satu permintaan ber-alias. Sepuluh cukup untuk satu halaman Workers
// dan menjaga teks query tetap pendek.
export const STATS_MAX_SCRIPTS = 10;
// Kuota harian bawaan per Worker untuk plan free Cloudflare (100.000 request/hari). Plan tidak
// bisa dibaca lewat API (endpoint billing 403), jadi angka ini hanya bawaan isian di panel dan
// boleh diubah pengguna.
export const DEFAULT_DAILY_QUOTA = 100000;
// Batas "aman" kuota: di bawah 80% aman, 80-100% peringatan, di atas 100% bahaya.
export const QUOTA_WARN_PERCENT = 80;
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

// todayWindow menyusun jendela "hari ini" versi UTC: 00:00:00Z hari ini sampai `nowMs`. UTC dipakai
// karena statistik Cloudflare memakai UTC — kalau memakai zona waktu browser (WIB = UTC+7), "hari
// ini" bergeser 7 jam dan angka kuota harian tidak lagi cocok dengan tanggal yang dihitung
// Cloudflare.
export function todayWindow(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  return {
    since: midnight.toISOString(),
    until: new Date(now).toISOString(),
  };
}

// normalizeScriptNames menerima satu nama atau daftar nama, memangkas spasi, membuang yang kosong
// dan duplikat, lalu memvalidasi tiap nama dengan SCRIPT_NAME. Hasil `{ names, rejected }`:
// `rejected` memuat nama yang bentuknya tidak sah supaya route bisa membalas 400 dengan nama yang
// salah — bukan diam-diam membuangnya lalu menampilkan angka untuk worker yang lain.
export function normalizeScriptNames(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
  const names = [];
  const rejected = [];
  for (const item of list) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name) continue;
    if (!SCRIPT_NAME.test(name)) {
      if (!rejected.includes(name)) rejected.push(name);
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  return { names: names, rejected: rejected };
}

// summarizeQuota meringkas pemakaian terhadap kuota harian:
// `{ used, quota, remaining, percent, level }` dengan level "ok" (<80%), "warn" (80-100%),
// "over" (>100%), dan "unknown" kalau kuotanya tidak masuk akal. `remaining` boleh negatif
// (pemakaian melewati kuota) supaya kelebihannya bisa disebutkan apa adanya.
export function summarizeQuota(used, dailyQuota) {
  const count = Math.max(0, Math.trunc(Number(used) || 0));
  const quota = Number.parseInt(String(dailyQuota ?? "").trim(), 10);
  if (!Number.isFinite(quota) || quota < 1) {
    return { used: count, quota: null, remaining: null, percent: null, level: "unknown" };
  }
  // Satu angka di belakang koma cukup: 12.4% tidak perlu 12.3456%.
  const percent = Math.round((count / quota) * 1000) / 10;
  // Level diputuskan dari angka mentah (bukan persen yang sudah dibulatkan) supaya pemakaian yang
  // sedikit melewati kuota tetap "over", tidak tersamar jadi 100%.
  const level = count * 100 < quota * QUOTA_WARN_PERCENT ? "ok" : count <= quota ? "warn" : "over";
  return { used: count, quota: quota, remaining: quota - count, percent: percent, level: level };
}

// buildInvocationsQuery menyusun body GraphQL untuk dataset workersInvocationsAdaptive:
// `{ query, variables, hours, since, until }`. Nama script dan account TIDAK pernah disisipkan ke
// teks query (itu celah injeksi); keduanya dikirim sebagai variabel, jadi JSON.stringify(body)
// yang meng-escape-nya. Jendela waktunya inklusif (`datetime_geq`/`datetime_leq`).
// `period: "today"` mengganti jendela jam dengan 00:00:00Z hari ini s/d sekarang (`hours` jadi
// null karena jendelanya bukan kelipatan jam).
export function buildInvocationsQuery(options) {
  const opts = options && typeof options === "object" ? options : {};
  const period = opts.period === "today" ? "today" : "hours";
  const hours = statsWindowHours(opts.hours);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const window = period === "today"
    ? todayWindow(nowMs)
    : { since: new Date(nowMs - hours * 3600 * 1000).toISOString(), until: new Date(nowMs).toISOString() };

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
      since: window.since,
      until: window.until,
    },
    hours: period === "hours" ? hours : null,
    period: period,
    since: window.since,
    until: window.until,
  };
}

// buildBatchInvocationsQuery menyusun SATU query GraphQL ber-alias untuk banyak script:
//   s0: workersInvocationsAdaptive(filter: { scriptName: $s0, ... }) { sum { requests errors } }
// Nama script tetap lewat variabel ($s0, $s1, ...) jadi tidak pernah masuk ke teks query. Batas
// jumlah nama ditegakkan route (STATS_MAX_SCRIPTS); di sini hanya nama yang sah yang dipakai.
export function buildBatchInvocationsQuery(options) {
  const opts = options && typeof options === "object" ? options : {};
  const { names } = normalizeScriptNames(opts.scriptNames);
  const period = opts.period === "today" ? "today" : "hours";
  const hours = statsWindowHours(opts.hours);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const window = period === "today"
    ? todayWindow(nowMs)
    : { since: new Date(nowMs - hours * 3600 * 1000).toISOString(), until: new Date(nowMs).toISOString() };

  const aliases = {};
  const variables = { accountTag: String(opts.accountId ?? "").trim() };
  const aliasVars = names.map((name, index) => {
    const alias = `s${index}`;
    aliases[alias] = name;
    variables[alias] = name;
    return alias;
  });
  variables.since = window.since;
  variables.until = window.until;

  const declarations = [`$accountTag: string!`]
    .concat(aliasVars.map((alias) => `$${alias}: string!`))
    .concat([`$since: Time!`, `$until: Time!`])
    .join(", ");

  const fields = aliasVars.map((alias) => [
    `      ${alias}: workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $${alias}, datetime_geq: $since, datetime_leq: $until }) {`,
    "        sum { requests errors }",
    "      }",
  ].join("\n"));

  return {
    query: [
      `query WorkerInvocationsBatch(${declarations}) {`,
      "  viewer {",
      "    accounts(filter: { accountTag: $accountTag }) {",
    ].concat(fields).concat([
      "    }",
      "  }",
      "}",
    ]).join("\n"),
    variables: variables,
    aliases: aliases,
    names: names,
    hours: period === "hours" ? hours : null,
    period: period,
    since: window.since,
    until: window.until,
  };
}

// readAliasedTotals membaca balasan query ber-alias: `{ <nama>: { requests, errors } }`.
// Alias yang tidak ada di balasan bernilai null supaya route bisa menyebut script mana yang
// datanya hilang — bukan menampilkan 0 untuk script yang tidak dijawab Cloudflare.
export function readAliasedTotals(payload, aliases) {
  const accounts = payload && payload.data && payload.data.viewer ? payload.data.viewer.accounts : null;
  if (!Array.isArray(accounts) || !accounts.length) return null;
  const account = accounts[0];
  if (!account || typeof account !== "object") return null;
  const map = aliases && typeof aliases === "object" ? aliases : {};
  const totals = {};
  let anyKnown = false;
  for (const [alias, name] of Object.entries(map)) {
    const groups = account[alias];
    if (!Array.isArray(groups)) {
      totals[name] = null;
      continue;
    }
    anyKnown = true;
    let requests = 0;
    let errors = 0;
    for (const group of groups) {
      requests += Number(group && group.sum ? group.sum.requests : 0) || 0;
      errors += Number(group && group.sum ? group.sum.errors : 0) || 0;
    }
    totals[name] = { requests: requests, errors: errors, groups: groups.length };
  }
  return anyKnown ? totals : null;
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
    const period = data && data.period === "today" ? "today" : "hours";
    const batchInput = data && Array.isArray(data.scriptNames) ? data.scriptNames : null;

    if (!cfEmail || !cfApiKey || !accountId) {
      return jsonResponse({ error: "Data Cloudflare tidak lengkap." }, 400);
    }

    const headers = {
      "X-Auth-Email": cfEmail,
      "X-Auth-Key": cfApiKey,
      "Content-Type": "application/json",
    };

    // --- mode banyak script: satu query ber-alias, satu permintaan -------------
    if (batchInput) {
      const { names, rejected } = normalizeScriptNames(batchInput);
      if (rejected.length) {
        return jsonResponse(
          {
            error: `Nama script tidak valid: ${rejected.map((name) => `"${name}"`).join(", ")}. Cloudflare hanya menerima huruf kecil, angka, "-" dan "_" (mis. cfvpn-vpn-sg).`,
          },
          400
        );
      }
      if (!names.length) {
        return jsonResponse({ error: "Daftar scriptNames kosong." }, 400);
      }
      if (names.length > STATS_MAX_SCRIPTS) {
        return jsonResponse(
          { error: `Maksimal ${STATS_MAX_SCRIPTS} script per permintaan (dikirim ${names.length}).` },
          400
        );
      }

      const built = buildBatchInvocationsQuery({
        accountId: accountId,
        scriptNames: names,
        period: period,
        hours: data && data.hours,
      });

      const response = await fetch(STATS_ENDPOINT, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ query: built.query, variables: built.variables }),
      });

      const payload = await response.json().catch(() => null);
      const graphErrors = payload && Array.isArray(payload.errors) ? payload.errors : [];
      if (!response.ok || graphErrors.length) {
        const failure = cloudflareStatsError(response.status, payload);
        return jsonResponse({ error: failure.message, needsScope: failure.needsScope }, failure.status);
      }

      const totals = readAliasedTotals(payload, built.aliases);
      if (!totals) {
        return jsonResponse(
          { error: "Balasan Cloudflare tidak memuat data workersInvocationsAdaptive." },
          400
        );
      }

      const results = {};
      const missing = [];
      for (const [name, item] of Object.entries(totals)) {
        if (!item) missing.push(name);
        else results[name] = { requests: item.requests, errors: item.errors };
      }
      if (missing.length) {
        return jsonResponse(
          { error: `Balasan Cloudflare tidak memuat data untuk: ${missing.join(", ")}.` },
          400
        );
      }

      const body = {
        ok: true,
        success: true,
        period: built.period,
        from: built.since,
        to: built.until,
        workers: names.length,
        results: results,
      };
      if (built.hours) body.hours = built.hours;

      // Kuota harian hanya masuk akal untuk jendela hari ini. Isian kuota yang tidak sah TIDAK
      // diganti angka bawaan secara diam-diam: tanpa kuota, balasan hanya memuat pemakaian.
      const dailyQuota = period === "today" ? positiveInt(data && data.dailyQuota) : null;
      if (dailyQuota) {
        const perScript = {};
        let usedTotal = 0;
        for (const [name, item] of Object.entries(results)) {
          perScript[name] = summarizeQuota(item.requests, dailyQuota);
          usedTotal += item.requests;
        }
        body.dailyQuota = dailyQuota;
        body.quota = perScript;
        // Kuota total = kuota per worker x jumlah worker yang dihitung (asumsi sama rata).
        body.total = Object.assign(summarizeQuota(usedTotal, dailyQuota * names.length), {
          workers: names.length,
        });
      }

      return jsonResponse(body, 200);
    }

    // --- mode satu script: bentuk balasan lama + period/from/to ----------------
    const scriptName = trimField(data && data.scriptName);

    if (!scriptName) {
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
      period: period,
    });

    const response = await fetch(STATS_ENDPOINT, {
      method: "POST",
      headers: headers,
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

    const singleBody = {
      success: true,
      ok: true,
      period: built.period,
      from: built.since,
      to: built.until,
      requests: totals.requests,
      errors: totals.errors,
    };
    if (built.hours) singleBody.hours = built.hours;
    const singleQuota = period === "today" ? positiveInt(data && data.dailyQuota) : null;
    if (singleQuota) singleBody.quota = summarizeQuota(totals.requests, singleQuota);

    return jsonResponse(singleBody, 200);
  } catch (error) {
    return jsonResponse({ error: (error && error.message) || "Gagal mengambil statistik." }, 500);
  }
}

function trimField(value) {
  return typeof value === "string" ? value.trim() : "";
}

// positiveInt membaca isian angka (kuota harian) dengan ketat: bukan angka atau < 1 berarti tidak
// ada kuota, bukan 0 dan bukan nilai bawaan.
function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// jsonResponse menyusun balasan JSON route ini (header tambahan, mis. Retry-After).
function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
  });
}
