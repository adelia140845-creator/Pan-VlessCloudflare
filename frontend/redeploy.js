// Logika murni untuk tombol "Deploy ulang semua Worker tersimpan" (halaman Deploy), plus helper
// token langganan Load Balancer yang dipakai jalur deploy tunggal dan tampilan URL langganan.
// Dipisah dari app.js supaya bisa diuji `node:test` tanpa DOM, Jaringan, maupun Cloudflare.

// Template per jenis worker. Nilainya HARUS sama dengan jalur deploy tunggal di renderDeploy
// (app.js): satu template VPN untuk semua tier + satu template Load Balancer.
export const REDEPLOY_TEMPLATES = {
  vpn: "/source/panvlesscloudflare.js",
  load_balancer: "/source/load-balancer.js",
};

// --- Token langganan Load Balancer -------------------------------------------

// 16 byte acak -> 32 karakter hex, cukup untuk token langganan (bukan sandi akun).
export const SUB_TOKEN_BYTES = 16;

// createSubToken: token acak 32 karakter hex. Sumber acaknya bisa disuntik untuk uji, bawaan
// crypto.getRandomValues (tersedia di browser maupun Worker).
export function createSubToken(getRandomValues = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(SUB_TOKEN_BYTES);
  getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ensureSubToken: pakai token worker apa adanya kalau sudah ada. Deploy ulang nama script yang
// sama TIDAK boleh membuat token baru — tautan langganan yang sudah dibagikan ke user akan mati
// kalau tokennya berputar. Token hanya dibuat untuk worker LB yang belum punya.
export function ensureSubToken(worker, getRandomValues) {
  const stored = typeof worker?.sub_token === "string" ? worker.sub_token.trim() : "";
  return stored || createSubToken(getRandomValues);
}

// withSubToken menyisipkan token langganan ke URL LB sebagai parameter `t` (nama yang dibaca
// template LB). Tanpa token URL dikembalikan apa adanya (LB lama yang belum punya binding
// SUB_TOKEN memang terbuka), dan URL yang sudah memuat `t` tidak ditulis dua kali. Sengaja tanpa
// `new URL()`: kartu worker menampilkan URL tanpa skema.
export function withSubToken(url, token) {
  const clean = typeof token === "string" ? token.trim() : "";
  if (!clean || typeof url !== "string" || !url) return url;
  if (/[?&]t=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(clean)}`;
}

// Binding env satu worker, disusun seperti deploy tunggal:
//   - VPN: UUID dikunci lewat UUID_ALLOWLIST (worker menolak UUID lain);
//   - Load Balancer: daftar VPN Worker yang terhubung dikirim sebagai VPN_DOMAINS_FREE, nama env
//     yang dibaca template LB (lihat /source/load-balancer.js) sebagai daftar domain cadangan
//     saat URL langganan tidak menyebut parameter `domains`, dan token langganan worker dikirim
//     sebagai SUB_TOKEN. Token di sini HANYA dibaca dari state (tidak pernah dibuat baru):
//     deploy ulang massal tidak boleh memutar token, supaya tautan langganan lama tetap jalan.
//     LB tersimpan yang belum punya token tetap dikirim tanpa SUB_TOKEN (terbuka, seperti dulu).
export function redeployVars(worker) {
  const vars = {};
  const uuid = typeof worker?.uuid === "string" ? worker.uuid.trim() : "";
  if (uuid) vars.UUID_ALLOWLIST = uuid;

  if (worker?.type === "load_balancer") {
    const domains = (Array.isArray(worker.vpn_domains) ? worker.vpn_domains : [])
      .map((domain) => String(domain).trim())
      .filter(Boolean);
    if (domains.length) vars.VPN_DOMAINS_FREE = domains.join(",");

    const token = typeof worker.sub_token === "string" ? worker.sub_token.trim() : "";
    if (token) vars.SUB_TOKEN = token;
  }

  return vars;
}

// redeployPlan menyusun urutan deploy ulang: satu langkah per worker tersimpan, urutannya sama
// dengan urutan di state. Loop di app.js menjalankannya satu per satu (sekuential), jadi urutan
// ini juga urutan permintaan ke /api/cf. Worker tanpa nama dilewati (tidak bisa jadi scriptName).
export function redeployPlan(workers) {
  return (Array.isArray(workers) ? workers : [])
    .filter((worker) => worker && typeof worker.name === "string" && worker.name.trim())
    .map((worker) => {
      const type = worker.type === "load_balancer" ? "load_balancer" : "vpn";
      return {
        id: worker.id ?? null,
        name: worker.name.trim(),
        type,
        template: REDEPLOY_TEMPLATES[type],
        vars: redeployVars({ ...worker, type }),
      };
    });
}

// redeployProgressLine menyusun satu baris progres: "deploy 3/12: nama — sukses".
// `result` kosong/undefined = permintaan belum selesai.
export function redeployProgressLine(index, total, name, result) {
  if (!result) return `deploy ${index}/${total}: ${name} — mengirim template...`;
  if (result.ok) return `deploy ${index}/${total}: ${name} — sukses`;
  return `deploy ${index}/${total}: ${name} — gagal (${result.error || "alasan tidak diketahui"})`;
}

// rateLimitInfo menerjemahkan balasan /api/cf: 429 berarti jatah permintaan per IP (bawaan
// 10 permintaan / 600 detik) habis, jadi loop harus BERHENTI, bukan diulang otomatis.
// Retry-After diambil dari header (diisi functions/api/cf.js), teks pesannya jadi cadangan.
export function rateLimitInfo(status, retryAfterHeader, data) {
  if (status !== 429) return { limited: false, retryAfter: null };

  const fromHeader = parseInt(String(retryAfterHeader ?? ""), 10);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return { limited: true, retryAfter: fromHeader };

  const match = /(\d+)\s*detik/i.exec(String(data?.error ?? ""));
  const fromBody = match ? parseInt(match[1], 10) : NaN;
  return { limited: true, retryAfter: Number.isFinite(fromBody) && fromBody > 0 ? fromBody : null };
}

// summarizeRedeploy merangkum hasil loop: jumlah sukses/gagal, dan — kalau ada balasan 429 —
// berapa worker yang dilewati karena limit beserta lama menunggunya. `plannedTotal` adalah
// jumlah langkah di redeployPlan; hasil yang belum tercatat sampai loop berhenti dihitung
// sebagai "dilewati", bukan "gagal", karena permintaannya memang tidak pernah dikirim.
export function summarizeRedeploy(results, plannedTotal) {
  const list = Array.isArray(results) ? results : [];
  const succeeded = list.filter((item) => item && item.ok).length;
  const failed = list.filter((item) => item && !item.ok && !item.limited);
  const limited = list.find((item) => item && item.limited) || null;
  const planned = Number.isInteger(plannedTotal) && plannedTotal >= list.length ? plannedTotal : list.length;
  const skipped = limited ? planned - list.length : 0;

  let message = `Ringkasan: ${succeeded} sukses, ${failed.length} gagal.`;

  if (limited) {
    const wait = limited.retryAfter
      ? `coba lagi setelah ${limited.retryAfter} detik`
      : "coba lagi setelah jendela rate limit lewat";
    message += ` Sisanya (${skipped} worker) dilewati karena limit 10 permintaan/10 menit; ${wait}.`;
  }

  if (failed.length) {
    const shown = failed.slice(0, 5).map((item) => `${item.name} (${item.error || "tanpa alasan"})`);
    const rest = failed.length - shown.length;
    message += ` Gagal: ${shown.join("; ")}${rest > 0 ? `; +${rest} gagal lain` : ""}.`;
  }

  return {
    planned,
    sent: list.length,
    ok: succeeded,
    failed: failed.length,
    skipped,
    stopped: Boolean(limited),
    retryAfter: limited ? limited.retryAfter : null,
    failedNames: failed.map((item) => item.name),
    message,
  };
}
