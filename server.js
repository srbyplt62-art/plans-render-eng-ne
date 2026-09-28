// ============================================================
// PLAN S — Render Motoru: Derinlik Haritası Servisi
// ============================================================
// Bu servis, web sitesinden/WhatsApp'tan gelen kat planı verisini
// (oda sınırları, pencere/kapı çizgileri, kamera noktaları) alır ve
// HER KAMERA NOKTASI İÇİN, o odanın basit bir 3D kütle modelinden
// üretilmiş bir DERİNLİK HARİTASI (depth map) döner.
//
// Bu derinlik haritaları, Make.com'daki bir sonraki adımda ControlNet'e
// verilir; ControlNet bu geometriyi kilitler, AI sadece ışık/doku/malzeme
// katmanını ekler. Böylece aynı odanın farklı açılardan render'larında
// mobilya/pencere/duvar konumu ASLA kaymaz — çünkü hepsi aynı, sabit
// 3D geometriden türüyor.
//
// NOT: Bu dosya SIFIR harici npm paketi kullanır (bu ortamda npm
// registry'ye erişim engelli çıktı — "host_not_allowed"). Sadece
// Node.js'in kendi yerleşik modülleri (http, zlib) kullanılıyor;
// HTTP sunucusu, JSON gövde ayrıştırma, CORS başlıkları ve PNG
// kodlayıcı (grayscale, zlib ile) elle yazıldı.
//
// NOT (ölçek varsayımı): Kat planında gerçek bir ölçü/kalibrasyon
// bilgisi olmadığından, 100 piksel = 1 birim (kabaca 1 metre) kabul
// edilir. Bu, oda ORANLARINI doğru tutar (derinlik haritası için asıl
// önemli olan budur); gerçek metrik doğruluk için ileride kullanıcıdan
// bilinen bir duvar uzunluğu istenip kalibrasyon eklenebilir.
// ============================================================

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const crypto = require('crypto');

const PX_PER_UNIT = 100;        // 100 piksel ≈ 1 birim (varsayım)
const EYE_HEIGHT = 1.6;         // kamera göz hizası (birim)
const CEILING_HEIGHT = 2.7;     // tavan yüksekliği (birim)
const FOV_DEGREES = 70;
const DEFAULT_SIZE = 640;       // çıktı görsel boyutu (px)
const NEAR = 0.05;
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// AYAR: Görsel üretim API'si (Replicate — ControlNet + SDXL).
// Kendi Replicate hesabınızdan bir API token'ı ve bir ControlNet-depth
// model versiyon hash'i alıp bunları ortam değişkeni olarak verin:
//   REPLICATE_API_TOKEN=r8_xxxxxxxx
//   REPLICATE_MODEL_VERSION=<replicate.com model sayfasındaki version id>
// REPLICATE_API_BASE test amaçlıdır — gerçek kullanımda değiştirmeyin.
// ---------------------------------------------------------------
const REPLICATE_API_BASE = process.env.REPLICATE_API_BASE || 'https://api.replicate.com/v1';
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || '';
const REPLICATE_MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION || '';
const GENERATE_POLL_INTERVAL_MS = 2000;
const GENERATE_POLL_MAX_ATTEMPTS = 45; // ~90 saniye

// Sabit malzeme/stil kütüphanesi: kullanıcı hangi stili seçerse seçsin,
// AYNI stil için HER ZAMAN aynı malzeme/mobilya tarifi kullanılır.
// Bu, aynı odanın farklı açılarında AI'ın rastgele farklı malzeme
// "icat etmesini" önleyen ikinci katmandır (birincisi: derinlik haritası).
const STYLE_PROMPTS = {
  MODERN_MINIMALIST: 'modern minimalist interior, matte white walls, light oak wood flooring, ' +
    'handleless flat-panel cabinetry in warm gray, brushed steel fixtures, clean geometric furniture, ' +
    'no clutter, neutral beige and off-white textiles',
  LUX_ISKANDINAV: 'luxury scandinavian interior, whitewashed oak flooring, soft cream and dusty ' +
    'blue textiles, brass accents, sheepskin throws, marble side tables, warm wood paneling, ' +
    'organic curved furniture silhouettes',
  ENDUSTRIYEL: 'industrial loft interior, exposed dark gray concrete walls, black steel window ' +
    'frames, polished concrete flooring, reclaimed wood furniture, exposed black ductwork, ' +
    'leather and canvas textiles, matte black fixtures'
};

const LIGHTING_PROMPTS = {
  GUN_BATIMI: 'warm golden hour sunset light streaming through windows, long soft shadows, ' +
    'amber and orange color temperature',
  GUN_ISIGI: 'bright natural daylight, soft diffused shadows, neutral white color temperature, ' +
    'clear daytime sky visible through windows',
  GECE_MODU: 'evening interior lighting, warm artificial lamps and pendant lights turned on, ' +
    'dark windows, cozy low-key ambient light, deep shadows'
};

// Bu metinler, buildFurnitureTriangles() ile yerleştirilen 3D mobilya
// kutularının konumuna KASITLI olarak uyumlu tutulur (masa+sandalye,
// koltuk+sehpa, yatak+komodin vb.) — derinlik haritasındaki geometri ile
// prompt'un anlattığı sahne birbirini desteklesin diye.
const ROOM_HINTS = {
  MUTFAK: 'kitchen with countertop, cabinetry, appliances, a small dining table and two chairs',
  SALON: 'living room with a sofa against the wall and a coffee table in front of it',
  BANYO: 'bathroom with a sink against one wall, a bathtub against another wall, tiled walls',
  YATAK_ODASI: 'bedroom with a bed against the wall flanked by two nightstands',
  ANTRE_HOL: 'entryway hall with a console table against the wall',
  TUVALET: 'small powder room with a toilet and a compact sink',
  KORIDOR: 'empty interior hallway/corridor, no furniture',
  BALKON: 'balcony with railing, seen from adjoining interior, no indoor furniture',
  MAKAM_ODASI: 'executive office with a round meeting table and chairs near the entrance, ' +
    'a large executive desk with a high-back leather chair on an area rug against the far wall, ' +
    'and a sofa seating cluster in the corner, curtained windows',
  TOPLANTI_ODASI: 'meeting room with a large oval conference table surrounded by office chairs, ' +
    'a wall-mounted display screen',
  PERSONEL_ODASI: 'staff break room with a round table and chairs, and a bench/sofa along one wall',
  RESEPSIYON: 'reception area with a reception desk facing the entrance and a small waiting seating area',
  ACIK_OFIS: 'open-plan office with rows of desks, office chairs, and partition screens',
  LOCKER_VESTIYER: 'cloakroom with a row of lockers along one wall and a coat rack'
};

const NEGATIVE_PROMPT = 'distorted geometry, warped walls, extra doors, extra windows, ' +
  'floating furniture, blurry, low quality, cartoon, illustration, watermark, text, people, humans';

const QUALITY_SUFFIX = 'photorealistic architectural interior render, professional real estate ' +
  'photography, 8k, sharp focus, physically based rendering';

// job_id + camera'ya bakmaksızın AYNI job_id için HER ZAMAN aynı seed
// üretir. Bu, aynı işin farklı kamera açılarında dokuların/malzeme
// varyasyonunun rastgele savrulmasını azaltır (geometri zaten derinlik
// haritasıyla kilitli; seed de dokusal rastgeleliği hizalar).
function seedFromJobId(jobId) {
  const hash = crypto.createHash('sha256').update(String(jobId)).digest();
  return hash.readUInt32BE(0) % 2147483647;
}

function buildPrompt(roomType, designStyle, lighting) {
  const stylePart = STYLE_PROMPTS[designStyle] || STYLE_PROMPTS.MODERN_MINIMALIST;
  const lightingPart = LIGHTING_PROMPTS[lighting] || LIGHTING_PROMPTS.GUN_ISIGI;
  const roomPart = ROOM_HINTS[roomType] || 'interior room';
  return `${roomPart}, ${stylePart}, ${lightingPart}, ${QUALITY_SUFFIX}`;
}

// Node'un yerleşik http/https modülleriyle JSON istek/cevap yardımcı fonksiyonu
// (axios/node-fetch yok — bu ortamda npm paket kurulumu engelli).
function requestJson(urlStr, { method = 'GET', headers = {}, bodyObj } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const bodyBuf = bodyObj !== undefined ? Buffer.from(JSON.stringify(bodyObj)) : null;

    const req = lib.request(u, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.length } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { /* JSON değilse ham metin döner */ }
        resolve({ statusCode: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bir derinlik haritasını (base64 PNG) alıp Replicate üzerinden ControlNet
// ile fotogerçekçi bir iç mekan görseline dönüştürür. Geometri, ControlNet'in
// "conditioning" girdisi olan bu derinlik haritasıyla kilitlenir — model
// sadece ışık/doku/malzeme üretir, duvar/pencere/kapı konumunu DEĞİŞTİREMEZ.
async function generateImageFromDepthMap({ jobId, cameraId, roomType, designStyle, lighting, depthMapBase64 }) {
  if (!REPLICATE_API_TOKEN) {
    throw new Error('REPLICATE_API_TOKEN ortam değişkeni tanımlı değil.');
  }
  if (!REPLICATE_MODEL_VERSION) {
    throw new Error('REPLICATE_MODEL_VERSION ortam değişkeni tanımlı değil.');
  }

  const prompt = buildPrompt(roomType, designStyle, lighting);
  const seed = seedFromJobId(jobId);

  const createRes = await requestJson(`${REPLICATE_API_BASE}/predictions`, {
    method: 'POST',
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
    bodyObj: {
      version: REPLICATE_MODEL_VERSION,
      input: {
        image: `data:image/png;base64,${depthMapBase64}`, // ControlNet depth conditioning görseli
        prompt,
        negative_prompt: NEGATIVE_PROMPT,
        seed
      }
    }
  });

  if (createRes.statusCode >= 300 || !createRes.json || !createRes.json.id) {
    throw new Error('Replicate iş oluşturma hatası (HTTP ' + createRes.statusCode + '): ' +
      (createRes.json && createRes.json.detail ? createRes.json.detail : createRes.raw));
  }

  const predictionId = createRes.json.id;
  let statusUrl = (createRes.json.urls && createRes.json.urls.get) ||
    `${REPLICATE_API_BASE}/predictions/${predictionId}`;

  for (let attempt = 0; attempt < GENERATE_POLL_MAX_ATTEMPTS; attempt++) {
    const pollRes = await requestJson(statusUrl, {
      method: 'GET',
      headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` }
    });

    const status = pollRes.json && pollRes.json.status;
    if (status === 'succeeded') {
      const output = pollRes.json.output;
      const imageUrl = Array.isArray(output) ? output[output.length - 1] : output;
      return { camera_id: cameraId, room_type: roomType, image_url: imageUrl, prediction_id: predictionId, seed, prompt };
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error('Replicate işi başarısız (' + status + '): ' +
        (pollRes.json && pollRes.json.error ? pollRes.json.error : 'bilinmeyen hata'));
    }
    await sleep(GENERATE_POLL_INTERVAL_MS);
  }

  throw new Error('Zaman aşımı: görsel üretim ' + GENERATE_POLL_MAX_ATTEMPTS + ' denemede tamamlanmadı.');
}

// ---------------- vektör yardımcıları ----------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1e-6;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// ---------------- kamera ----------------
function makeCamera(eye, target) {
  const forward = norm(sub(target, eye));
  const worldUp = [0, 1, 0];
  let right = cross(forward, worldUp);
  if (Math.hypot(...right) < 1e-4) right = [1, 0, 0]; // tam yukarı/aşağı bakış edge-case
  right = norm(right);
  const up = norm(cross(right, forward));
  return { eye, forward, right, up };
}

function project(p3, cam, outW, outH, focal) {
  const rel = sub(p3, cam.eye);
  const vx = dot(rel, cam.right);
  const vy = dot(rel, cam.up);
  const vz = dot(rel, cam.forward);
  if (vz <= NEAR) return null; // kameranın arkasında / çok yakın
  return {
    x: (vx / vz) * focal + outW / 2,
    y: -(vy / vz) * focal + outH / 2,
    z: vz
  };
}

// ---------------- rasterizer (z-buffer'lı üçgen doldurma) ----------------
function makeBuffer(w, h) {
  return {
    w, h,
    depth: new Float32Array(w * h).fill(Infinity),
    gray: new Uint8ClampedArray(w * h)
  };
}

function rasterTriangle(buf, p0, p1, p2, colorFn) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
  const maxX = Math.min(buf.w - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
  const maxY = Math.min(buf.h - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
  if (minX > maxX || minY > maxY) return;

  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
  if (Math.abs(area) < 1e-6) return;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((p1.x - px) * (p2.y - py) - (p1.y - py) * (p2.x - px)) / area;
      const w1 = ((p2.x - px) * (p0.y - py) - (p2.y - py) * (p0.x - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;

      const z = w0 * p0.z + w1 * p1.z + w2 * p2.z;
      const idx = y * buf.w + x;
      if (z < buf.depth[idx]) {
        buf.depth[idx] = z;
        buf.gray[idx] = colorFn(z);
      }
    }
  }
}

function depthToGray(z, near, far) {
  const t = Math.min(1, Math.max(0, (z - near) / (far - near)));
  return Math.round(255 * (1 - t)); // yakın = parlak, uzak = koyu (MiDaS kuralı)
}

// ---------------- eksenlere hizalı kutu → 12 üçgen (6 yüz) ----------------
function boxTriangles(x0, y0, z0, x1, y1, z1) {
  const p = {
    '000': [x0, y0, z0], '100': [x1, y0, z0], '010': [x0, y1, z0], '110': [x1, y1, z0],
    '001': [x0, y0, z1], '101': [x1, y0, z1], '011': [x0, y1, z1], '111': [x1, y1, z1]
  };
  return [
    [p['000'], p['100'], p['101']], [p['000'], p['101'], p['001']], // alt
    [p['010'], p['111'], p['110']], [p['010'], p['011'], p['111']], // üst
    [p['000'], p['010'], p['011']], [p['000'], p['011'], p['001']], // batı
    [p['100'], p['110'], p['111']], [p['100'], p['111'], p['101']], // doğu
    [p['000'], p['100'], p['110']], [p['000'], p['110'], p['010']], // kuzey
    [p['001'], p['101'], p['111']], [p['001'], p['111'], p['011']]  // güney
  ];
}

// Merkez (cx,cz fraksiyon 0..1) + mutlak boyut (birim/metre) verilen bir
// mobilya kutusunu, oda sınırları içinde kalacak şekilde kırpıp üretir.
// Oda çok küçükse (kutu sığmıyorsa) null döner — o parça atlanır, duvardan
// taşan/gömülen mobilya oluşmaz.
function placedBox(W, D, cxFrac, czFrac, sizeX, sizeZ, y0, y1, margin) {
  margin = margin === undefined ? 0.08 : margin;
  if (sizeX + 2 * margin > W || sizeZ + 2 * margin > D) return null;

  let cx = cxFrac * W, cz = czFrac * D;
  const halfX = sizeX / 2, halfZ = sizeZ / 2;
  cx = Math.min(Math.max(cx, margin + halfX), W - margin - halfX);
  cz = Math.min(Math.max(cz, margin + halfZ), D - margin - halfZ);

  return boxTriangles(cx - halfX, y0, cz - halfZ, cx + halfX, y1, cz + halfZ);
}

// Oda türüne göre SABİT (rastgele olmayan) bir mobilya şablonu üretir.
// Aynı oda boyutu + aynı oda türü → HER ZAMAN aynı mobilya konumu/boyutu.
// Bu, kamera açısı değişse de mobilyanın yerinin/şeklinin kaymamasının
// garantisidir — tıpkı duvar ve pencere/kapı gibi, derinlik haritasına
// gerçek 3D geometri olarak işleniyor.
function buildFurnitureTriangles(roomType, W, D, H) {
  const tris = [];
  const push = (b) => { if (b) tris.push(...b); };

  if (roomType === 'MUTFAK') {
    // Mutfak masası (merkeze yakın) + karşılıklı 2 sandalye
    push(placedBox(W, D, 0.5, 0.55, 1.1, 0.7, 0.75, 0.78, 0.15));
    push(placedBox(W, D, 0.5, 0.35, 0.45, 0.45, 0, 0.45, 0.15));
    push(placedBox(W, D, 0.5, 0.75, 0.45, 0.45, 0, 0.45, 0.15));
    // Tezgah (kuzey duvara yaslı, ince ve uzun)
    push(placedBox(W, D, 0.5, 0.08, W * 0.7, 0.6, 0, 0.9, 0.05));
  } else if (roomType === 'SALON') {
    // Koltuk (güney duvara yaslı, geniş) + sehpa (önünde)
    push(placedBox(W, D, 0.5, 0.85, Math.min(2.0, W * 0.6), 0.85, 0, 0.8, 0.1));
    push(placedBox(W, D, 0.5, 0.55, 1.0, 0.5, 0, 0.42, 0.1));
  } else if (roomType === 'YATAK_ODASI') {
    // Yatak (kuzey duvara yaslı, geniş) + 2 komodin
    push(placedBox(W, D, 0.5, 0.28, Math.min(1.6, W * 0.55), 2.0, 0, 0.55, 0.1));
    push(placedBox(W, D, 0.18, 0.28, 0.4, 0.4, 0, 0.5, 0.05));
    push(placedBox(W, D, 0.82, 0.28, 0.4, 0.4, 0, 0.5, 0.05));
  } else if (roomType === 'BANYO') {
    // Lavabo (batı duvara yaslı) + küvet/duşa kabin (doğu duvara yaslı)
    push(placedBox(W, D, 0.12, 0.18, 0.55, 0.4, 0.75, 0.9, 0.05));
    push(placedBox(W, D, 0.85, 0.5, 0.5, Math.min(1.6, D * 0.6), 0, 0.55, 0.05));
  } else if (roomType === 'TUVALET') {
    // Klozet + küçük lavabo (tek köşe grubu)
    push(placedBox(W, D, 0.75, 0.75, 0.4, 0.45, 0, 0.4, 0.08));
    push(placedBox(W, D, 0.2, 0.18, 0.4, 0.35, 0.75, 0.88, 0.05));
  } else if (roomType === 'ANTRE_HOL') {
    // Konsol masası (bir duvara yaslı, ince)
    push(placedBox(W, D, 0.5, 0.1, Math.min(1.2, W * 0.5), 0.35, 0.7, 0.85, 0.1));
  } else if (roomType === 'MAKAM_ODASI') {
    // Makam odası: giriş duvarına yakın yuvarlak toplantı masası + 2 sandalye
    push(placedBox(W, D, 0.22, 0.18, 1.1, 1.1, 0.72, 0.75, 0.1));   // yuvarlak masa (kutu yaklaşımı)
    push(placedBox(W, D, 0.22, 0.32, 0.45, 0.45, 0, 0.45, 0.1));    // sandalye
    push(placedBox(W, D, 0.36, 0.10, 0.45, 0.45, 0, 0.45, 0.1));    // sandalye
    // Karşı (kuzey) duvarda makam masası + arkasında yüksek sırtlı koltuk, halı üzerinde
    push(placedBox(W, D, 0.74, 0.55, 1.8, 0.85, 0, 0.76, 0.1));     // makam masası (desk)
    push(placedBox(W, D, 0.74, 0.30, 0.65, 0.65, 0, 0.95, 0.05));   // yüksek sırtlı koltuk (masanın arkasında, duvara yakın)
    // Köşede koltuk takımı (oturma grubu)
    push(placedBox(W, D, 0.14, 0.85, 1.9, 0.75, 0, 0.42, 0.08));    // koltuk/kanepe
    push(placedBox(W, D, 0.36, 0.85, 0.5, 0.5, 0, 0.42, 0.08));     // tekli koltuk/puf
  } else if (roomType === 'TOPLANTI_ODASI') {
    // Büyük oval toplantı masası (kutu yaklaşımı) + etrafında sandalyeler
    push(placedBox(W, D, 0.5, 0.5, Math.min(2.6, W * 0.7), Math.min(1.3, D * 0.5), 0.72, 0.75, 0.15));
    push(placedBox(W, D, 0.22, 0.28, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.5, 0.22, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.78, 0.28, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.22, 0.72, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.5, 0.78, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.78, 0.72, 0.45, 0.45, 0, 0.45, 0.1));
  } else if (roomType === 'PERSONEL_ODASI') {
    // Yuvarlak masa + sandalyeler
    push(placedBox(W, D, 0.35, 0.3, 0.9, 0.9, 0.72, 0.75, 0.1));
    push(placedBox(W, D, 0.35, 0.12, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.15, 0.3, 0.45, 0.45, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.55, 0.3, 0.45, 0.45, 0, 0.45, 0.1));
    // Bench/kanepe (güney duvara yaslı)
    push(placedBox(W, D, 0.5, 0.85, Math.min(1.8, W * 0.55), 0.7, 0, 0.42, 0.1));
  } else if (roomType === 'RESEPSIYON') {
    // Resepsiyon bankosu (girişe bakan, kuzey duvara yaslı) + bekleme koltukları
    push(placedBox(W, D, 0.5, 0.15, Math.min(2.2, W * 0.6), 0.6, 0, 1.05, 0.1));
    push(placedBox(W, D, 0.2, 0.75, 0.55, 0.55, 0, 0.45, 0.1));
    push(placedBox(W, D, 0.8, 0.75, 0.55, 0.55, 0, 0.45, 0.1));
  } else if (roomType === 'ACIK_OFIS') {
    // Sıra sıra masalar (2 sıra x 2 masa, basitleştirilmiş)
    push(placedBox(W, D, 0.25, 0.25, 0.9, 0.6, 0.7, 0.74, 0.1));
    push(placedBox(W, D, 0.25, 0.65, 0.9, 0.6, 0.7, 0.74, 0.1));
    push(placedBox(W, D, 0.7, 0.25, 0.9, 0.6, 0.7, 0.74, 0.1));
    push(placedBox(W, D, 0.7, 0.65, 0.9, 0.6, 0.7, 0.74, 0.1));
  } else if (roomType === 'LOCKER_VESTIYER') {
    // Duvara yaslı locker sırası
    push(placedBox(W, D, 0.5, 0.08, Math.min(2.4, W * 0.8), 0.45, 0, 1.9, 0.05));
  }
  // KORIDOR ve BALKON: varsayılan olarak mobilya eklenmiyor (boş geçiş alanları).

  return tris;
}

// ---------------- oda kutusu + açıklık (pencere/kapı) geometrisi ----------------
function buildRoomGeometry(room, openings) {
  const W = (room.bbox.x_max - room.bbox.x_min) / PX_PER_UNIT;
  const D = (room.bbox.y_max - room.bbox.y_min) / PX_PER_UNIT;
  const H = CEILING_HEIGHT;

  const c = {
    '000': [0, 0, 0], '100': [W, 0, 0], '010': [0, H, 0], '110': [W, H, 0],
    '001': [0, 0, D], '101': [W, 0, D], '011': [0, H, D], '111': [W, H, D]
  };

  const shellTriangles = [
    [c['000'], c['100'], c['101']], [c['000'], c['101'], c['001']], // taban
    [c['010'], c['111'], c['110']], [c['010'], c['011'], c['111']], // tavan
    [c['000'], c['010'], c['011']], [c['000'], c['011'], c['001']], // batı duvar (x=0)
    [c['100'], c['110'], c['111']], [c['100'], c['111'], c['101']], // doğu duvar (x=W)
    [c['000'], c['100'], c['110']], [c['000'], c['110'], c['010']], // kuzey duvar (z=0)
    [c['001'], c['101'], c['111']], [c['001'], c['111'], c['011']]  // güney duvar (z=D)
  ];

  const markerTriangles = []; // { tris:[[p,p,p],[p,p,p]], mark }

  (openings || []).forEach(o => {
    const midX = (o.line.x1 + o.line.x2) / 2;
    const midY = (o.line.y1 + o.line.y2) / 2;
    const tol = 30;
    const inX = midX >= room.bbox.x_min - tol && midX <= room.bbox.x_max + tol;
    const inY = midY >= room.bbox.y_min - tol && midY <= room.bbox.y_max + tol;
    if (!inX || !inY) return;

    const distTop = Math.abs(midY - room.bbox.y_min);
    const distBottom = Math.abs(midY - room.bbox.y_max);
    const distLeft = Math.abs(midX - room.bbox.x_min);
    const distRight = Math.abs(midX - room.bbox.x_max);
    const minDist = Math.min(distTop, distBottom, distLeft, distRight);

    const isDoor = o.type === 'KAPI';
    const yBase = isDoor ? 0 : H * 0.33;
    const yTop = isDoor ? H * 0.75 : H * 0.55;
    const markW = 0.9; // açıklık genişliği (~90cm varsayım)
    const nudge = 0.02; // z-fighting'i önlemek için duvardan içeri kayma

    let cx, cz, corners;
    if (minDist === distTop) { // kuzey duvar z=0
      cx = ((midX - room.bbox.x_min) / PX_PER_UNIT / W) * W;
      corners = [
        [cx - markW / 2, yBase, nudge], [cx + markW / 2, yBase, nudge],
        [cx + markW / 2, yTop, nudge], [cx - markW / 2, yTop, nudge]
      ];
    } else if (minDist === distBottom) { // güney duvar z=D
      cx = ((midX - room.bbox.x_min) / PX_PER_UNIT / W) * W;
      corners = [
        [cx - markW / 2, yBase, D - nudge], [cx + markW / 2, yBase, D - nudge],
        [cx + markW / 2, yTop, D - nudge], [cx - markW / 2, yTop, D - nudge]
      ];
    } else if (minDist === distLeft) { // batı duvar x=0
      cz = ((midY - room.bbox.y_min) / PX_PER_UNIT / D) * D;
      corners = [
        [nudge, yBase, cz - markW / 2], [nudge, yBase, cz + markW / 2],
        [nudge, yTop, cz + markW / 2], [nudge, yTop, cz - markW / 2]
      ];
    } else { // doğu duvar x=W
      cz = ((midY - room.bbox.y_min) / PX_PER_UNIT / D) * D;
      corners = [
        [W - nudge, yBase, cz - markW / 2], [W - nudge, yBase, cz + markW / 2],
        [W - nudge, yTop, cz + markW / 2], [W - nudge, yTop, cz - markW / 2]
      ];
    }

    markerTriangles.push({
      tris: [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]],
      mark: o.type
    });
  });

  const furnitureTriangles = buildFurnitureTriangles(room.room_type, W, D, H);

  return { W, D, H, shellTriangles, markerTriangles, furnitureTriangles };
}

// ---------------- tek bir kamera için derinlik haritası render et ----------------
function renderDepthMap(room, openings, cameraPxPos, outSize) {
  const geo = buildRoomGeometry(room, openings);

  const camX = (cameraPxPos.x - room.bbox.x_min) / PX_PER_UNIT;
  const camZ = (cameraPxPos.y - room.bbox.y_min) / PX_PER_UNIT;
  const eye = [
    Math.min(Math.max(camX, 0.15), geo.W - 0.15),
    EYE_HEIGHT,
    Math.min(Math.max(camZ, 0.15), geo.D - 0.15)
  ];
  const target = [geo.W / 2, EYE_HEIGHT, geo.D / 2];
  const cam = makeCamera(eye, target);

  const w = outSize, h = outSize;
  const focal = (w / 2) / Math.tan((FOV_DEGREES * Math.PI / 180) / 2);
  const buf = makeBuffer(w, h);
  const far = Math.hypot(geo.W, geo.D, geo.H) + 1;

  geo.shellTriangles.forEach(([a, b, c]) => {
    const pa = project(a, cam, w, h, focal);
    const pb = project(b, cam, w, h, focal);
    const pc = project(c, cam, w, h, focal);
    if (!pa || !pb || !pc) return;
    rasterTriangle(buf, pa, pb, pc, (z) => depthToGray(z, NEAR, far));
  });

  // Mobilya: duvarla AYNI şekilde gerçek (sürekli) derinlik gölgelendirmesi
  // kullanır — çünkü bunlar sahte işaretler değil, gerçek 3D hacimlerdir.
  // Z-buffer sayesinde duvarların önünde doğru şekilde görünürler.
  geo.furnitureTriangles.forEach(([a, b, c]) => {
    const pa = project(a, cam, w, h, focal);
    const pb = project(b, cam, w, h, focal);
    const pc = project(c, cam, w, h, focal);
    if (!pa || !pb || !pc) return;
    rasterTriangle(buf, pa, pb, pc, (z) => depthToGray(z, NEAR, far));
  });

  geo.markerTriangles.forEach(({ tris, mark }) => {
    const fixedGray = mark === 'PENCERE' ? 235 : 25; // pencere: çok parlak, kapı: çok koyu
    tris.forEach(([a, b, c]) => {
      const pa = project(a, cam, w, h, focal);
      const pb = project(b, cam, w, h, focal);
      const pc = project(c, cam, w, h, focal);
      if (!pa || !pb || !pc) return;
      rasterTriangle(buf, pa, pb, pc, () => fixedGray);
    });
  });

  return buf;
}

// ============================================================
// PNG kodlayıcı — sıfır bağımlılık (sadece Node'un zlib'i)
// ============================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// buf.gray (Uint8ClampedArray, w*h), buf.depth (Infinity = veri yok → siyah)
function encodeGrayscalePng(buf) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(buf.w, 0);
  ihdrData.writeUInt32BE(buf.h, 4);
  ihdrData.writeUInt8(8, 8);   // bit depth
  ihdrData.writeUInt8(0, 9);   // color type: grayscale
  ihdrData.writeUInt8(0, 10);  // compression
  ihdrData.writeUInt8(0, 11);  // filter
  ihdrData.writeUInt8(0, 12);  // interlace
  const ihdr = pngChunk('IHDR', ihdrData);

  // Her satır: 1 filtre byte'ı (0 = None) + w piksel
  const raw = Buffer.alloc(buf.h * (1 + buf.w));
  for (let y = 0; y < buf.h; y++) {
    const rowStart = y * (1 + buf.w);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < buf.w; x++) {
      const idx = y * buf.w + x;
      const v = buf.depth[idx] === Infinity ? 0 : buf.gray[idx];
      raw[rowStart + 1 + x] = v;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idat = pngChunk('IDAT', compressed);
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function pointInBbox(pt, bbox) {
  return pt.x >= bbox.x_min && pt.x <= bbox.x_max && pt.y >= bbox.y_min && pt.y <= bbox.y_max;
}

// ============================================================
// Basit HTTP sunucusu (Express yok — Node'un kendi http modülü)
// ============================================================

function sendJson(res, statusCode, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('İstek gövdesi çok büyük.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('Geçersiz JSON gövdesi: ' + err.message));
      }
    });
    req.on('error', reject);
  });
}

async function handleDepthMaps(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 5 * 1024 * 1024); // 5MB sınır
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const { rooms, openings, camera_views, outSize } = body || {};
  if (!Array.isArray(rooms) || rooms.length === 0) {
    return sendJson(res, 400, { error: 'rooms dizisi zorunlu ve boş olamaz.' });
  }
  if (!Array.isArray(camera_views) || camera_views.length === 0) {
    return sendJson(res, 400, { error: 'camera_views dizisi zorunlu ve boş olamaz.' });
  }

  const size = Math.min(1024, Math.max(256, outSize || DEFAULT_SIZE));
  const renders = [];
  const skipped = [];

  for (const cam of camera_views) {
    const room = rooms.find(r => pointInBbox(cam.position, r.bbox));
    if (!room) {
      skipped.push({ camera_id: cam.id, reason: 'Bu nokta hiçbir odanın sınırları içinde değil.' });
      continue;
    }
    const roomOpenings = (openings || []).filter(o => {
      const midX = (o.line.x1 + o.line.x2) / 2;
      const midY = (o.line.y1 + o.line.y2) / 2;
      const tol = 30;
      return midX >= room.bbox.x_min - tol && midX <= room.bbox.x_max + tol &&
             midY >= room.bbox.y_min - tol && midY <= room.bbox.y_max + tol;
    });

    try {
      const buf = renderDepthMap(room, roomOpenings, cam.position, size);
      const pngBuffer = encodeGrayscalePng(buf);
      renders.push({
        camera_id: cam.id,
        room_type: room.room_type,
        width: size,
        height: size,
        depth_map_png_base64: pngBuffer.toString('base64')
      });
    } catch (err) {
      skipped.push({ camera_id: cam.id, reason: 'Render hatası: ' + err.message });
    }
  }

  sendJson(res, 200, { renders, skipped });
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 6 * 1024 * 1024); // derinlik haritası base64 dahil, biraz daha geniş sınır
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const { job_id, camera_id, room_type, design_style, lighting, depth_map_png_base64 } = body || {};
  const missing = ['job_id', 'camera_id', 'room_type', 'design_style', 'lighting', 'depth_map_png_base64']
    .filter((k) => !body || !body[k]);
  if (missing.length > 0) {
    return sendJson(res, 400, { error: 'Eksik alan(lar): ' + missing.join(', ') });
  }

  try {
    const result = await generateImageFromDepthMap({
      jobId: job_id,
      cameraId: camera_id,
      roomType: room_type,
      designStyle: design_style,
      lighting,
      depthMapBase64: depth_map_png_base64
    });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 502, { camera_id, error: err.message });
  }
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'plan-s-render-engine' });
  }

  if (req.method === 'POST' && url === '/depth-maps') {
    try {
      return await handleDepthMaps(req, res);
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'Sunucu hatası: ' + err.message });
    }
  }

  if (req.method === 'POST' && url === '/generate') {
    try {
      return await handleGenerate(req, res);
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'Sunucu hatası: ' + err.message });
    }
  }

  sendJson(res, 404, { error: 'Bulunamadı: ' + req.method + ' ' + url });
});

server.listen(PORT, () => {
  console.log('Plan S render engine dinliyor: ' + PORT);
});

module.exports = { server, renderDepthMap, encodeGrayscalePng, buildRoomGeometry };
