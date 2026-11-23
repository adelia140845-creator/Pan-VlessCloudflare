// Daftar negara untuk pemilih filter di Generator.
//
// Pool proxy tidak selalu memberi label negara untuk semua barisnya, jadi daftar dari pool saja bisa
// hanya berisi dua negara walau pool-nya ratusan baris. Pilihan filter memakai gabungan: kode ISO
// 3166-1 yang lengkap + kode apa pun yang muncul di pool (supaya kode tak dikenal tidak hilang).
export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM FO " +
  "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT " +
  "JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM " +
  "MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR " +
  "PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH " +
  "TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

// countryOptionList mengembalikan kode negara unik 2 huruf, urut abjad: ISO lengkap + kode dari pool.
export function countryOptionList(poolCountries) {
  const codes = new Set(COUNTRY_CODES);
  for (const raw of Array.isArray(poolCountries) ? poolCountries : []) {
    const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (/^[A-Z]{2}$/.test(code)) codes.add(code);
  }
  return [...codes].sort();
}

// Nama Indonesia untuk tiap kode di COUNTRY_CODES, supaya filter negara bisa dicari dengan nama
// ("Singapura"), bukan cuma kode. Satu daftar ringkas, satu nama per kode.
export const COUNTRY_NAMES = {
  AD: "Andorra", AE: "Uni Emirat Arab", AF: "Afganistan", AG: "Antigua dan Barbuda", AI: "Anguilla", AL: "Albania",
  AM: "Armenia", AO: "Angola", AR: "Argentina", AS: "Samoa Amerika", AT: "Austria", AU: "Australia", AW: "Aruba",
  AX: "Kepulauan Aland", AZ: "Azerbaijan", BA: "Bosnia dan Herzegovina", BB: "Barbados", BD: "Bangladesh",
  BE: "Belgia", BF: "Burkina Faso", BG: "Bulgaria", BH: "Bahrain", BI: "Burundi", BJ: "Benin",
  BL: "Saint Barthelemy", BM: "Bermuda", BN: "Brunei Darussalam", BO: "Bolivia", BQ: "Kepulauan Karibia Belanda",
  BR: "Brasil", BS: "Bahama", BT: "Bhutan", BV: "Pulau Bouvet", BW: "Botswana", BY: "Belarus", BZ: "Belize",
  CA: "Kanada", CC: "Kepulauan Cocos", CD: "Kongo (Republik Demokratik)", CF: "Republik Afrika Tengah", CG: "Kongo",
  CH: "Swiss", CI: "Pantai Gading", CK: "Kepulauan Cook", CL: "Chili", CM: "Kamerun", CN: "Tiongkok",
  CO: "Kolombia", CR: "Kosta Rika", CU: "Kuba", CV: "Tanjung Verde", CW: "Curacao", CX: "Pulau Natal",
  CY: "Siprus", CZ: "Ceko", DE: "Jerman", DJ: "Djibouti", DK: "Denmark", DM: "Dominika", DO: "Republik Dominika",
  DZ: "Aljazair", EC: "Ekuador", EE: "Estonia", EG: "Mesir", ER: "Eritrea", ES: "Spanyol", ET: "Etiopia",
  FI: "Finlandia", FJ: "Fiji", FK: "Kepulauan Falkland", FM: "Mikronesia", FO: "Kepulauan Faroe", FR: "Prancis",
  GA: "Gabon", GB: "Inggris", GD: "Grenada", GE: "Georgia", GF: "Guyana Prancis", GG: "Guernsey", GH: "Ghana",
  GI: "Gibraltar", GL: "Greenland", GM: "Gambia", GN: "Guinea", GP: "Guadeloupe", GQ: "Guinea Ekuatorial",
  GR: "Yunani", GS: "Georgia Selatan", GT: "Guatemala", GU: "Guam", GW: "Guinea-Bissau", GY: "Guyana",
  HK: "Hong Kong", HM: "Pulau Heard dan Kepulauan McDonald", HN: "Honduras", HR: "Kroasia", HT: "Haiti",
  HU: "Hungaria", ID: "Indonesia", IE: "Irlandia", IL: "Israel", IM: "Pulau Man", IN: "India",
  IO: "Wilayah Samudra Hindia Britania", IQ: "Irak", IR: "Iran", IS: "Islandia", IT: "Italia", JE: "Jersey",
  JM: "Jamaika", JO: "Yordania", JP: "Jepang", KE: "Kenya", KG: "Kirgizstan", KH: "Kamboja", KI: "Kiribati",
  KM: "Komoro", KN: "Saint Kitts dan Nevis", KP: "Korea Utara", KR: "Korea Selatan", KW: "Kuwait",
  KY: "Kepulauan Cayman", KZ: "Kazakhstan", LA: "Laos", LB: "Lebanon", LC: "Saint Lucia", LI: "Liechtenstein",
  LK: "Sri Lanka", LR: "Liberia", LS: "Lesotho", LT: "Lituania", LU: "Luksemburg", LV: "Latvia", LY: "Libya",
  MA: "Maroko", MC: "Monako", MD: "Moldova", ME: "Montenegro", MF: "Saint Martin", MG: "Madagaskar",
  MH: "Kepulauan Marshall", MK: "Makedonia Utara", ML: "Mali", MM: "Myanmar", MN: "Mongolia", MO: "Makau",
  MP: "Kepulauan Mariana Utara", MQ: "Martinik", MR: "Mauritania", MS: "Montserrat", MT: "Malta",
  MU: "Mauritius", MV: "Maladewa", MW: "Malawi", MX: "Meksiko", MY: "Malaysia", MZ: "Mozambik", NA: "Namibia",
  NC: "Kaledonia Baru", NE: "Niger", NF: "Pulau Norfolk", NG: "Nigeria", NI: "Nikaragua", NL: "Belanda",
  NO: "Norwegia", NP: "Nepal", NR: "Nauru", NU: "Niue", NZ: "Selandia Baru", OM: "Oman", PA: "Panama",
  PE: "Peru", PF: "Polinesia Prancis", PG: "Papua Nugini", PH: "Filipina", PK: "Pakistan", PL: "Polandia",
  PM: "Saint Pierre dan Miquelon", PN: "Kepulauan Pitcairn", PR: "Puerto Riko", PS: "Palestina", PT: "Portugal",
  PW: "Palau", PY: "Paraguay", QA: "Qatar", RE: "Reunion", RO: "Rumania", RS: "Serbia", RU: "Rusia",
  RW: "Rwanda", SA: "Arab Saudi", SB: "Kepulauan Solomon", SC: "Seychelles", SD: "Sudan", SE: "Swedia",
  SG: "Singapura", SH: "Saint Helena", SI: "Slovenia", SJ: "Svalbard dan Jan Mayen", SK: "Slowakia",
  SL: "Sierra Leone", SM: "San Marino", SN: "Senegal", SO: "Somalia", SR: "Suriname", SS: "Sudan Selatan",
  ST: "Sao Tome dan Principe", SV: "El Salvador", SX: "Sint Maarten", SY: "Suriah", SZ: "Eswatini",
  TC: "Kepulauan Turks dan Caicos", TD: "Chad", TF: "Wilayah Selatan Prancis", TG: "Togo", TH: "Thailand",
  TJ: "Tajikistan", TK: "Tokelau", TL: "Timor Leste", TM: "Turkmenistan", TN: "Tunisia", TO: "Tonga",
  TR: "Turki", TT: "Trinidad dan Tobago", TV: "Tuvalu", TW: "Taiwan", TZ: "Tanzania", UA: "Ukraina",
  UG: "Uganda", UM: "Kepulauan Terluar Amerika Serikat", US: "Amerika Serikat", UY: "Uruguay",
  UZ: "Uzbekistan", VA: "Vatikan", VC: "Saint Vincent dan Grenadines", VE: "Venezuela",
  VG: "Kepulauan Virgin Britania", VI: "Kepulauan Virgin Amerika Serikat", VN: "Vietnam", VU: "Vanuatu",
  WF: "Wallis dan Futuna", WS: "Samoa", YE: "Yaman", YT: "Mayotte", ZA: "Afrika Selatan", ZM: "Zambia",
  ZW: "Zimbabwe",
};

// Nama dicocokkan tanpa huruf besar/kecil dan tanpa diakritik/tanda baca, spasi dirapatkan.
const nameKey = (text) => String(text || "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// resolveCountry memetakan isi kolom filter negara (yang bisa diketik) ke SATU kode 2 huruf, atau ""
// kalau kosong / tidak dikenali / ambigu — pemanggil yang memutuskan pesannya. Menerima kode
// ("SG", "sg", " Sg "), label panel ("🇸🇬 SG · 3 segar"), dan nama Indonesia ("Singapura").
// Nama dicocokkan utuh dulu, lalu sebagai awalan (untuk mengetik sebagian); dua kandidat atau lebih
// dianggap ambigu dan ditolak, bukan ditebak.
export function resolveCountry(input, codes) {
  const list = (Array.isArray(codes) ? codes : COUNTRY_CODES).map((c) => String(c).trim().toUpperCase());
  // Label panel memuat emoji bendera + embel-embel jumlah: buang keduanya sebelum dicocokkan.
  const text = String(input ?? "").replace(/[\u{1F1E6}-\u{1F1FF}]/gu, " ").split("·")[0].trim();
  if (!text) return "";
  if (/^[A-Za-z]{2}$/.test(text)) {
    const code = text.toUpperCase();
    return list.includes(code) ? code : "";
  }
  const key = nameKey(text);
  if (!key) return "";
  const named = list.map((code) => ({ code, name: nameKey(COUNTRY_NAMES[code]) })).filter((entry) => entry.name);
  const exact = named.filter((entry) => entry.name === key);
  if (exact.length) return exact.length === 1 ? exact[0].code : "";
  const prefix = named.filter((entry) => entry.name.startsWith(key));
  return prefix.length === 1 ? prefix[0].code : "";
}