// Uji pemilihan header autentikasi Cloudflare: API Token (`cfut_...`) vs Global API Key.
// Token hanya sah lewat Bearer; Global API Key hanya sah lewat X-Auth-Email + X-Auth-Key.
// Kalau bentuk yang salah dikirim, Cloudflare menolak dengan error autentikasi — jadi pemilihan
// ini menentukan apakah panel bisa memakai token yang dimiliki user.
import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareAuthHeaders, isCfToken, needsCfEmail } from "../functions/api/lib/cf-auth.js";

test("token cfut_ dikirim sebagai Bearer, email diabaikan", () => {
  const headers = cloudflareAuthHeaders("user@example.com", "cfut_abc123");
  assert.deepEqual(headers, { Authorization: "Bearer cfut_abc123" });
  assert.equal("X-Auth-Email" in headers, false, "Bearer tidak dicampur X-Auth-Email");
});

test("Global API Key tetap memakai X-Auth-Email + X-Auth-Key", () => {
  const key = "0123456789abcdef0123456789abcdef01234";
  assert.deepEqual(cloudflareAuthHeaders("user@example.com", key), {
    "X-Auth-Email": "user@example.com",
    "X-Auth-Key": key,
  });
});

test("spasi di sekitar kredensial dipangkas, huruf besar pada awalan token diterima", () => {
  assert.deepEqual(cloudflareAuthHeaders(" user@example.com ", "  cfut_abc  "), { Authorization: "Bearer cfut_abc" });
  assert.deepEqual(cloudflareAuthHeaders("", "CFUT_abc"), { Authorization: "Bearer CFUT_abc" });
});

test("Global API Key tanpa email: hanya X-Auth-Key (validasi route yang menolak)", () => {
  assert.deepEqual(cloudflareAuthHeaders("", "0123456789abcdef"), { "X-Auth-Key": "0123456789abcdef" });
});

test("isCfToken/needsCfEmail: hanya awalan cfut_ yang dianggap token", () => {
  assert.equal(isCfToken("cfut_xyz"), true);
  assert.equal(isCfToken("0123456789abcdef0123456789abcdef01234"), false, "Global API Key bukan token");
  assert.equal(isCfToken(undefined), false);
  assert.equal(needsCfEmail("cfut_xyz"), false);
  assert.equal(needsCfEmail("0123456789abcdef"), true);
});