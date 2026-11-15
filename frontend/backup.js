// Export/import state panel (daftar worker + counter) ke satu berkas JSON.
//
// Dipisah dari app.js supaya validasinya bisa diuji `node:test` tanpa DOM maupun jaringan
// (tests/backup-state.test.mjs). Modul ini murni: tidak menyentuh localStorage, Supabase, atau
// DOM — pemanggil (blok dashboard di app.js) yang memutuskan kapan `saveState` dijalankan.
//
// Format berkas: { format, version, exportedAt, username, workerCount, state: { ... } }.
// `parseState` juga menerima state mentah (tanpa pembungkus) supaya berkas hasil `JSON.stringify`
// manual atau backup versi lama tetap bisa dipulihkan.

export const BACKUP_FORMAT = "cfvpn-hub-state";
export const BACKUP_VERSION = 1;

// Jenis worker yang dikenal panel. Nilai ini HARUS sama dengan yang dipakai renderWorkers /
// redeployPlan ("vpn" dan "load_balancer"); jenis lain berarti berkas bukan backup panel ini.
export const WORKER_TYPES = ["vpn", "load_balancer"];

// Urutan field di sini = urutan tampil di berkas, dan `JSON.stringify` dengan indentasi 2 spasi
// membuat berkas enak di-diff / dibaca manusia.
export function serializeState(state, meta = {}) {
  const source = state && typeof state === "object" ? state : {};
  const workers = Array.isArray(source.workers) ? source.workers : [];
  const generatedCount = Number.isFinite(source.generatedCount) ? Math.max(0, Math.trunc(source.generatedCount)) : 0;
  const exportedAt = typeof meta.exportedAt === "string" && meta.exportedAt ? meta.exportedAt : new Date().toISOString();

  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt,
      username: typeof meta.username === "string" ? meta.username : "",
      workerCount: workers.length,
      state: { ...source, generatedCount, workers },
    },
    null,
    2
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// parseState(text) -> { ok: true, state, duplicates } atau { ok: false, error }.
//
// Validasi sengaja ketat dan berhenti di kesalahan pertama: berkas rusak harus DITOLAK utuh, bukan
// diimpor sebagian — state lama tetap utuh sampai pemanggil menggantinya. Yang diperiksa:
//   * berkas bukan teks kosong dan JSON-nya bisa di-parse;
//   * isi berupa objek (bukan array/null) dan punya `workers` berupa array;
//   * tiap entri objek dengan `name` (teks, tidak kosong setelah di-trim) dan `type` yang dikenal;
//   * `id` duplikat dibuang (entri pertama yang dipertahankan) karena id dipakai sebagai kunci
//     kartu worker & tombol aksi; entri tanpa id diberi id baru.
export function parseState(text, options = {}) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "Berkas kosong atau tidak terbaca sebagai teks." };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: "Bukan JSON yang valid: " + String((error && error.message) || error) };
  }

  if (!isPlainObject(payload)) {
    return { ok: false, error: "Isi berkas harus satu objek JSON, bukan array atau nilai tunggal." };
  }

  // Berkas panel dibungkus `state`; berkas mentah (tanpa pembungkus) diterima apa adanya.
  const raw = isPlainObject(payload.state) ? payload.state : payload;
  if (!Array.isArray(raw.workers)) {
    return { ok: false, error: "State tidak punya daftar worker (field \"workers\" harus array)." };
  }

  const makeId = typeof options.makeId === "function" ? options.makeId : () => crypto.randomUUID();
  const seen = new Set();
  const workers = [];
  let duplicates = 0;

  for (let index = 0; index < raw.workers.length; index += 1) {
    const entry = raw.workers[index];
    const position = index + 1;
    if (!isPlainObject(entry)) {
      return { ok: false, error: `Worker ke-${position} bukan objek.` };
    }

    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) return { ok: false, error: `Worker ke-${position} tidak punya nama.` };

    const type = typeof entry.type === "string" ? entry.type.trim() : "";
    if (!WORKER_TYPES.includes(type)) {
      return { ok: false, error: `Worker ke-${position} ("${name}") punya jenis tidak dikenal: "${String(entry.type)}".` };
    }

    const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
    if (rawId && seen.has(rawId)) {
      duplicates += 1;
      continue; // id duplikat dibuang, entri pertama yang menang
    }
    const id = rawId || makeId();
    seen.add(id);

    workers.push({
      ...entry,
      id,
      name,
      type,
      active: typeof entry.active === "boolean" ? entry.active : true,
    });
  }

  const generatedCount = Number.isFinite(raw.generatedCount) ? Math.max(0, Math.trunc(raw.generatedCount)) : 0;
  return { ok: true, duplicates, state: { ...raw, generatedCount, workers } };
}
