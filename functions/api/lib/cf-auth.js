// Header autentikasi Cloudflare API.
//
// Cloudflare menerima dua bentuk kredensial dan menolaknya silang: API Token hanya sah lewat
// `Authorization: Bearer`, sedangkan Global API Key hanya sah lewat `X-Auth-Email` + `X-Auth-Key`.
// Panel menerima keduanya di satu isian "API key": token dikenali dari awalan `cfut_`, selain itu
// dianggap Global API Key dan email dipakai.
export function isCfToken(secret) {
  const value = typeof secret === "string" ? secret.trim() : "";
  return /^cfut_/i.test(value);
}

// cloudflareAuthHeaders mengembalikan objek header siap pakai. Untuk token, email diabaikan
// (Cloudflare akan menolak kalau Bearer dicampur X-Auth-Email).
export function cloudflareAuthHeaders(email, secret) {
  const key = typeof secret === "string" ? secret.trim() : "";
  if (isCfToken(key)) return { Authorization: "Bearer " + key };

  const mail = typeof email === "string" ? email.trim() : "";
  if (!mail) return { "X-Auth-Key": key };
  return { "X-Auth-Email": mail, "X-Auth-Key": key };
}

// needsCfEmail: true kalau kredensial ini menuntut email (Global API Key), false untuk token.
export function needsCfEmail(secret) {
  return !isCfToken(secret);
}