// Kunci dan klien TULIS Supabase untuk cron-worker (PATCH proxy_pool: is_active/ping/tunnel_*).
//
// Kontrak repo: SETIAP request TULIS memakai service key yang dipasang lewat
// `wrangler secret put SUPABASE_SERVICE_KEY`. Kalau rahasia itu belum dipasang, worker jatuh
// kembali ke anon key lama supaya siklus cron tidak mati, dan mencetak peringatan SEKALI per
// isolate. `warnState` dipegang pemanggil (module scope index.js) karena hanya di sana batas
// isolate diketahui; peringatan tiap 10 menit hanya mengubur error lain di `wrangler tail`.
//
// Tulis sengaja tidak lewat @supabase/supabase-js: satu PATCH sederhana cukup memakai fetch dengan
// header yang disusun di sini, dan berkas ini jadi tanpa dependensi sehingga bisa diuji di Node
// polos (tests/cron-tunnel.test.mjs) — tepat di bagian yang paling perlu dibuktikan, key mana yang
// benar-benar dikirim. Bacaan (select proxy_pool) tetap memakai supabase-js dengan anon key di
// index.js karena pool memang boleh dibaca anon.
const PROXY_POOL_PATH = "/rest/v1/proxy_pool";

export function createProxyPoolWriter(supabaseUrl, anonKey, env, warnState) {
  const serviceKey = env && typeof env.SUPABASE_SERVICE_KEY === "string"
    ? env.SUPABASE_SERVICE_KEY.trim()
    : "";

  if (!serviceKey) {
    const warned = warnState || { warned: false };
    if (!warned.warned) {
      warned.warned = true;
      console.warn("SUPABASE_SERVICE_KEY belum dipasang — tulis proxy_pool jatuh kembali ke anon key. Pasang: wrangler secret put SUPABASE_SERVICE_KEY (project lumbbmhhmkcnxunuryjr).");
    }
  }

  const key = serviceKey || anonKey;
  const base = String(supabaseUrl).replace(/\/+$/, "");

  return {
    // PATCH satu baris. Bentuk balasan mengikuti supabase-js ({ error }) supaya patchProxy tidak
    // perlu tahu siapa kliennya. `Prefer: return=minimal` = tanpa badan balasan saat sukses, sama
    // seperti `update()` tanpa `select()`.
    async patch(id, fields) {
      let response;
      try {
        response = await globalThis.fetch(base + PROXY_POOL_PATH + "?id=eq." + encodeURIComponent(String(id)), {
          method: "PATCH",
          headers: {
            apikey: key,
            authorization: "Bearer " + key,
            "content-type": "application/json",
            prefer: "return=minimal",
          },
          body: JSON.stringify(fields),
        });
      } catch (err) {
        return { error: { message: err && err.message ? err.message : String(err) } };
      }
      if (response.ok) return { error: null };
      return { error: await postgrestError(response) };
    },
  };
}

// Badan error PostgREST ({ code, message, details, hint }) diteruskan apa adanya supaya
// isMissingColumnError tetap mengenali PGRST204/42703; balasan yang bukan JSON (mis. 502 HTML)
// dikembalikan sebagai pesan teks supaya errornya tetap terlihat di log.
async function postgrestError(response) {
  const text = await response.text().catch(function () { return ""; });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }
  if (body && typeof body === "object") return Object.assign({ status: response.status }, body);
  return { status: response.status, message: text || (response.status + " " + response.statusText) };
}
