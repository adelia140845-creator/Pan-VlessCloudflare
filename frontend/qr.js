// QR panel: memilih sumber QR dan menggambarnya memakai lib vendor (frontend/vendor/qrcode.js).
//
// Sengaja TIDAK memakai layanan QR online: teks yang di-encode adalah config vless:// dan URL
// langganan bertoken (rahasia akun). Semua penggambaran terjadi di browser dari berkas milik
// origin sendiri, sehingga tidak ada byte pun yang dikirim ke pihak ketiga dan panel tetap bisa
// membuat QR saat offline (berkas vendor ikut di-cache service worker).

const VENDOR_URL = "/vendor/qrcode.js";
const CONFIG_SCHEME = /^(vless|trojan|ss|vmess):\/\//i;

// Baris pertama yang berupa URI config. Area hasil generator bisa berisi banyak baris (format raw)
// atau bukan URI sama sekali (V2Ray base64, Clash YAML, Sing-box JSON) — QR hanya masuk akal untuk
// satu URI, jadi baris URI pertama yang dipakai (bukan seluruh isi textarea).
export function firstConfigUri(configText) {
  const text = typeof configText === "string" ? configText : "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (CONFIG_SCHEME.test(line)) return line;
  }
  return "";
}

// Sumber QR untuk panel: config (kalau ada URI-nya) dan URL langganan (kalau ada dan berbeda).
// Setiap sumber diberi label supaya user tahu QR mana yang harus dipindai.
export function qrTargets(configText, subUrl) {
  const targets = [];
  const config = firstConfigUri(configText);
  if (config) targets.push({ kind: "config", label: "Config", text: config });

  const sub = typeof subUrl === "string" ? subUrl.trim() : "";
  // Dedup: URL langganan yang identik dengan config (mis. satu config yang sama) tidak diulang.
  if (sub && !targets.some((target) => target.text === sub)) {
    targets.push({ kind: "subscription", label: "URL Langganan", text: sub });
  }
  return targets;
}

let qrLibPromise = null;

// Muat lib vendor sekali per halaman, hanya saat QR benar-benar diminta: baris-QR jarang dipakai,
// jadi halaman generator tidak perlu mengunduh 380 KB di setiap kunjungan.
export function ensureQrLib() {
  if (typeof window !== "undefined" && window.QRCode) return Promise.resolve(window.QRCode);
  if (qrLibPromise) return qrLibPromise;

  qrLibPromise = new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Pustaka QR hanya bisa dimuat di browser."));
      return;
    }
    const script = document.createElement("script");
    script.src = VENDOR_URL;
    script.async = true;
    script.onload = () => {
      if (window.QRCode) resolve(window.QRCode);
      else reject(new Error(`Pustaka QR di ${VENDOR_URL} termuat, tapi tidak menyediakan window.QRCode.`));
    };
    script.onerror = () => {
      qrLibPromise = null; // biar bisa dicoba lagi (mis. tadi offline, sekarang sudah tersambung)
      reject(new Error(`Gagal memuat pustaka QR dari ${VENDOR_URL}. Periksa koneksi lalu klik QR lagi.`));
    };
    document.head.appendChild(script);
  });
  return qrLibPromise;
}

// Gambar QR dari `text` ke dalam `el` (elemen dikosongkan lebih dulu). Mengembalikan elemen <img>
// yang dipasang, supaya pemanggil bisa menunggu/menguji hasilnya.
export async function renderQrInto(el, text, options = {}) {
  if (!el) throw new Error("Elemen QR tidak tersedia.");
  const payload = typeof text === "string" ? text.trim() : "";
  if (!payload) throw new Error("Tidak ada teks untuk dibuat QR.");

  const QRCode = await ensureQrLib();
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: options.errorCorrectionLevel || "M",
    margin: 1,
    width: options.width || 512,
  });
  if (!dataUrl) throw new Error("Pustaka QR tidak mengembalikan gambar.");

  const doc = el.ownerDocument;
  const img = doc.createElement("img");
  img.className = "qr-image";
  img.alt = options.alt || "QR";
  img.src = dataUrl;
  img.width = options.displayWidth || 220;
  img.height = options.displayWidth || 220;
  el.replaceChildren(img);
  return img;
}
