// Uji daftar negara untuk pemilih filter Generator: ISO lengkap + kode dari pool, unik dan urut.
import test from "node:test";
import assert from "node:assert/strict";
import { COUNTRY_CODES, COUNTRY_NAMES, countryOptionList, resolveCountry } from "../frontend/countries.js";

test("ISO 3166-1 lengkap: >200 kode, semuanya 2 huruf besar dan unik", () => {
  assert.ok(COUNTRY_CODES.length > 200, "jumlah kode: " + COUNTRY_CODES.length);
  assert.equal(new Set(COUNTRY_CODES).size, COUNTRY_CODES.length, "tidak ada duplikat");
  for (const code of COUNTRY_CODES) assert.match(code, /^[A-Z]{2}$/);
  for (const code of ["ID", "SG", "US", "DE", "JP", "MY"]) assert.ok(COUNTRY_CODES.includes(code), code + " harus ada");
});

test("countryOptionList: gabungan ISO + kode pool, unik, urut abjad", () => {
  const list = countryOptionList(["id", " sg ", "ZZ", "??", "", null, 42]);
  assert.ok(list.includes("ID") && list.includes("SG"), "kode pool ikut (huruf kecil dipetakan ke besar)");
  assert.ok(list.includes("ZZ"), "kode tak dikenal dari pool tetap tersedia");
  assert.equal(list.includes("??"), false, "label kosong tidak jadi opsi");
  assert.equal(new Set(list).size, list.length);
  assert.deepEqual(list, [...list].sort());
});

test("countryOptionList: masukan kosong/bukan array tetap memberi daftar ISO", () => {
  assert.equal(countryOptionList(undefined).length, COUNTRY_CODES.length);
  assert.equal(countryOptionList("ID").length, COUNTRY_CODES.length, "string bukan daftar kode");
});

// Filter negara di Generator bisa DIKETIK, jadi tiap kode butuh nama Indonesia untuk dicari.
test("COUNTRY_NAMES: tiap kode ISO punya satu nama, tidak ada nama kembar", () => {
  const names = COUNTRY_CODES.map((code) => {
    assert.equal(typeof COUNTRY_NAMES[code], "string", code + " belum punya nama");
    assert.ok(COUNTRY_NAMES[code].length > 1, code + " namanya kosong");
    return COUNTRY_NAMES[code];
  });
  assert.equal(new Set(names).size, names.length, "nama tidak boleh dipakai dua kode");
});

test("resolveCountry: kode (huruf besar/kecil + spasi) hanya diterima kalau ada di daftar", () => {
  assert.equal(resolveCountry("SG"), "SG");
  assert.equal(resolveCountry("sg"), "SG");
  assert.equal(resolveCountry(" Sg "), "SG");
  assert.equal(resolveCountry("ID"), "ID");
  assert.equal(resolveCountry("ZZ"), "", "kode di luar daftar bukan pilihan yang sah");
  assert.equal(resolveCountry("ZZ", ["ZZ"]), "ZZ", "kode yang dikirim pemanggil tetap diterima");
  assert.equal(resolveCountry("x"), "", "satu huruf bukan kode");
});

test("resolveCountry: label panel beremoji bendera (dengan/tanpa jumlah segar)", () => {
  assert.equal(resolveCountry("🇸🇬 SG"), "SG");
  assert.equal(resolveCountry("🇸🇬 SG · 3 segar"), "SG");
  assert.equal(resolveCountry("🇸🇪 SE · 0 segar"), "SE");
  assert.equal(resolveCountry("🇸🇬"), "", "emoji bendera tanpa kode = tidak dikenali");
});

test("resolveCountry: nama Indonesia, nama utuh menang atas awalan", () => {
  assert.equal(resolveCountry("Singapura"), "SG");
  assert.equal(resolveCountry("singapura"), "SG");
  assert.equal(resolveCountry("  Swedia "), "SE");
  assert.equal(resolveCountry("Amerika Serikat"), "US");
  assert.equal(resolveCountry("Kongo"), "CG", "nama utuh (CG) menang atas awalan 'Kongo (Republik Demokratik)' (CD)");
  assert.equal(resolveCountry("Sudan Selatan"), "SS");
  assert.equal(resolveCountry("Niger"), "NE", "nama utuh menang atas awalan 'Nigeria'");
  assert.equal(resolveCountry("singap"), "SG", "awalan yang cuma cocok satu negara boleh");
});

test("resolveCountry: kosong -> \"\" (pemanggil membacanya sebagai semua negara)", () => {
  assert.equal(resolveCountry(""), "");
  assert.equal(resolveCountry("   "), "");
  assert.equal(resolveCountry(undefined), "");
  assert.equal(resolveCountry(null), "");
  assert.equal(resolveCountry("!!!"), "");
});

test("resolveCountry: tidak dikenal dan ambigu -> \"\" (bukan ditebak)", () => {
  assert.equal(resolveCountry("xyz"), "");
  assert.equal(resolveCountry("Negara Antah Berantah"), "");
  assert.equal(resolveCountry("Korea"), "", "Korea Utara/Korea Selatan = ambigu");
  assert.equal(resolveCountry("mal"), "", "Malaysia/Maladewa/Mali/Malta = ambigu");
  assert.equal(resolveCountry("SGX"), "", "tiga huruf bukan kode dan bukan nama");
});
