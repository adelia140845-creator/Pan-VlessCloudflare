// Binding env Worker untuk jalur upload CLI (deploy-bulk.mjs), dipisah dari skripnya karena
// deploy-bulk.mjs mengeksekusi menu interaktif di tingkat atas (tidak bisa diimpor begitu saja).
// Semua nilai dibaca dari objek env yang dioper pemanggil (bukan process.env langsung) supaya
// jalur penyusunan binding bisa diuji tanpa menembak API Cloudflare.
//
// Nama binding di sini HARUS sama dengan nama env yang dibaca template:
//   - RELAY_SERVER_UDP / RELAY_SERVER_PORT / RELAY_SERVER_TLS / RELAY_SECRET -> template VPN
//     (panvlesscloudflare.js). Template sekarang selalu `TIER_FREE = true`, jadi relay UDP
//     diabaikan worker walau binding ini terpasang.
//   - SUB_TOKEN -> template Load Balancer (load-balancer.js) untuk mengunci /api/v1/sub.

// Binding relay UDP: hanya aktif kalau RELAY_SERVER_UDP diisi di lingkungan shell (nama env-nya
// sengaja sama dengan nama binding di Worker).
export function relayBindings(env = {}) {
  const host = String(env.RELAY_SERVER_UDP || "").trim();
  if (!host) return [];
  const secret = String(env.RELAY_SECRET || "").trim();
  if (!secret) {
    throw new Error("RELAY_SERVER_UDP diisi tapi RELAY_SECRET kosong — relay akan menolak sambungan.");
  }
  return [
    { type: "plain_text", name: "RELAY_SERVER_UDP", text: host },
    { type: "plain_text", name: "RELAY_SERVER_PORT", text: String(env.RELAY_SERVER_PORT || "7300").trim() },
    { type: "plain_text", name: "RELAY_SERVER_TLS", text: String(env.RELAY_SERVER_TLS || "").trim() },
    { type: "plain_text", name: "RELAY_SECRET", text: secret },
  ].filter((binding) => binding.text);
}

// subToken membaca SUB_TOKEN dari env shell apa adanya (tidak ada nilai bawaan: token acak tidak
// pernah dibuat di jalur CLI — token dibuat panel saat deploy LB, lalu dipasang operator di sini).
export function subToken(env = {}) {
  return String(env.SUB_TOKEN || "").trim();
}

// subTokenBindings: kunci langganan HANYA untuk Load Balancer dan HANYA kalau SUB_TOKEN diisi.
// Tanpa SUB_TOKEN, LB yang di-deploy lewat CLI terbuka seperti LB lama (pemanggil yang memutuskan
// perlu memperingatkan operatornya, bukan helper ini).
export function subTokenBindings(type, env = {}) {
  if (type !== "load_balancer") return [];
  const token = subToken(env);
  return token ? [{ type: "plain_text", name: "SUB_TOKEN", text: token }] : [];
}

// workerBindings: seluruh binding untuk satu Worker, urut relay dulu lalu token langganan.
export function workerBindings(type, env = {}) {
  return [...relayBindings(env), ...subTokenBindings(type, env)];
}
