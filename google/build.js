'use strict';
/*
  Builds Google Ads HTML5 zips from ../index.html (the site banner is the single source of the animation).

    cd google && npm install && npm run build

  Inputs:  backgrounds at 2x: assets/bg-600x500*.jpg and assets/bg-600x1200*.jpg (or google/src/bg-<format>.jpg).
           If a background is missing, a placeholder is cut from ../assets/bg.png.
  Output:  google/dist/<format>/ (unzipped, used by the preview page google/index.html)
           google/dist/arax-toamna-<format>.zip (upload these to Google Ads)

  Every format uses the site's design units: the stage is 1085 units wide, so all animation constants stay valid,
  and only positions/sizes below are per format. The stage is scaled to the ad size at runtime.

  Image quality: each format walks down QUALITY_LADDER and keeps the first rung whose zip fits TARGET_ZIP,
  so every format gets the best quality that still passes Google's 600 KB limit.
*/
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');

const MAX_ZIP = 600 * 1000;            // Google Ads: zip of 600 KB or smaller (the stricter reading: 600 000 bytes)
const TARGET_ZIP = 580 * 1000;         // aim a little below the limit
const MAX_FILES = 40;                  // Google Ads: no more than 40 files
const ALLOWED_EXT = new Set(['.html', '.css', '.js', '.gif', '.png', '.jpg', '.jpeg', '.svg']);
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];   // Google Fonts is the allowed external
const STOP_AT = 27.0;                  // seconds; a touch-down moment, well inside the 30 s limit
const BG_DENSITY = 2;                  // backgrounds are supplied at 2x of the ad size

// bgQ: background JPEG quality (full 4:4:4 colour); girlD / cloudD: pixel density vs. on-screen size;
// girlQ: girl JPEG quality (true colour, alpha travels in a separate mask). Clouds stay palette PNG: near-lossless for that art.
const QUALITY_LADDER = [
  { bgQ: 92, girlD: 3, girlQ: 90, cloudD: 3 },
  { bgQ: 90, girlD: 3, girlQ: 88, cloudD: 3 },
  { bgQ: 88, girlD: 2.5, girlQ: 90, cloudD: 3 },
  { bgQ: 88, girlD: 2.5, girlQ: 88, cloudD: 2.5 },
  { bgQ: 85, girlD: 2.5, girlQ: 86, cloudD: 2.5 },
  { bgQ: 82, girlD: 2, girlQ: 86, cloudD: 2 },
  { bgQ: 80, girlD: 2, girlQ: 85, cloudD: 2 },
];

// source art, native pixels
const GIRL = { w: 1086, h: 1449, tip: [473, 41], foot: [663.5, 1393], leg: 558 }; // fingertip, standing-foot contact, standing leg left edge
const CLOUD = { w: 1085, h: 1449,
  deLa: { rect: [110, 566, 222, 622], window: [60, 540, 300, 680] } };   // baked "de la" text: erase box and the area scanned for its glyphs
const SW = 1085;                       // design width of every format

// ----- per-format layout, in design units (stage is 1085 wide) -----
// id names the output folder and zip; bg is the background for that version (2x of the ad size).
const LAYOUT_300x250 = {
  w: 300, h: 250, leaves: 14,
  cloud: { x: 120, y: 0, w: 660 },
  girl: { x: 560, y: 110, w: 600 },
  cta: { x: 30, y: 712, font: 42 },
  deLa: { font: 34 },
  label: { right: 34, top: 26, font: 40 },
  placeholderPosition: 'bottom',
};
const FORMATS = [
  { id: '300x250', bg: 'assets/bg-600x500-HQ.jpg', ...LAYOUT_300x250 },
  { id: '300x250-2', bg: 'assets/bg-600x500-HQ-2.jpg', ...LAYOUT_300x250 },
  {
    id: '300x600', bg: 'assets/bg-600x1200-HQ.jpg', w: 300, h: 600, leaves: 22,
    cloud: { x: 22, y: 70, w: 1040 },
    girl: { x: 150, y: 722, w: 1000 },
    cta: { x: 36, y: 1670, font: 44 },
    deLa: { font: 36 },
    label: { left: 40, bottom: 56, font: 40 },
    placeholderPosition: 'centre',
    // edge darkening baked into the background only (more contrast for the clouds, button and label)
    shade: { top: { to: 0.5, alpha: 0.24, color: [4, 14, 38] }, bottom: { from: 0.72, alpha: 0.28, color: [8, 6, 4] } },
  },
];

// Soft top/bottom gradient as an SVG overlay; eased stops so no edge of the gradient is visible.
function shadeSVG(W, H, s) {
  const ease = [[0, 1], [0.2, 0.62], [0.45, 0.3], [0.7, 0.1], [1, 0]];          // offset -> share of the edge alpha
  const stops = (c, a, rev) => (rev ? [...ease].reverse() : ease).map(([o, k]) =>
    `<stop offset="${rev ? 1 - o : o}" stop-color="rgb(${c.join(',')})" stop-opacity="${(a * k).toFixed(3)}"/>`).join('');
  let defs = '', rects = '';
  if (s.top) {
    const h = Math.round(H * s.top.to);
    defs += `<linearGradient id="t" x1="0" y1="0" x2="0" y2="1">${stops(s.top.color, s.top.alpha, false)}</linearGradient>`;
    rects += `<rect x="0" y="0" width="${W}" height="${h}" fill="url(#t)"/>`;
  }
  if (s.bottom) {
    const y = Math.round(H * s.bottom.from);
    defs += `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1">${stops(s.bottom.color, s.bottom.alpha, true)}</linearGradient>`;
    rects += `<rect x="0" y="${y}" width="${W}" height="${H - y}" fill="url(#b)"/>`;
  }
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>${defs}</defs>${rects}</svg>`);
}

const r2 = v => Math.round(v * 100) / 100;
const kb = n => (n / 1024).toFixed(1) + ' KB';

function rep(s, a, b, label) {
  if (!s.includes(a)) throw new Error('template changed, cannot find: ' + (label || a.slice(0, 60)));
  return s.split(a).join(b);
}

function geometry(f) {
  const H = SW * f.h / f.w;
  const scale = f.w / SW;                          // design unit -> CSS px
  const cs = f.cloud.w / 960;                      // cloud scale vs the site banner
  const cloudH = f.cloud.w * CLOUD.h / CLOUD.w;
  const stackTop = -44 * cs;
  const k = f.girl.w / GIRL.w;                     // girl native px -> design units
  const gs = f.girl.w / 640;                       // girl scale vs the site banner
  const tip = [f.girl.x + GIRL.tip[0] * k, f.girl.y + GIRL.tip[1] * k];
  const ox = (tip[0] - f.cloud.x) / f.cloud.w * 100;
  const oy = (tip[1] - (f.cloud.y + stackTop)) / cloudH * 100;
  const foot = [f.girl.x + GIRL.foot[0] * k, f.girl.y + GIRL.foot[1] * k];
  const legX = f.girl.x + GIRL.leg * k;
  const fs_ = f.cta.font, g = fs_ / 36;
  const cta = {
    h: Math.round(fs_ * 2.55), padL: Math.round(fs_ * .9), padR: Math.round(fs_ * .72), gap: Math.round(fs_ * .33),
    arrowW: Math.round(fs_ * .6), arrowH: Math.round(fs_ * .82), g,
  };
  cta.w = cta.padL + fs_ * 10.77 + cta.gap + cta.arrowW + cta.padR;   // Montserrat 800, measured: 10.95 x font size, minus letter-spacing
  return { H, scale, cs, cloudH, stackTop, k, gs, tip, ox, oy, foot, legX, cta };
}

function css(f, G) {
  const c = G.cta, L = f.label;
  const labelPos = ['left', 'right', 'top', 'bottom'].filter(p => L[p] !== undefined).map(p => `${p}:${L[p]}px`).join(';');
  return `
  /* ===== ${f.id}: generated by google/build.js ===== */
  html,body{background:#5aa9ff}
  :root{--w:${SW};--h:${r2(G.H)}}
  .cloudWrap{left:${f.cloud.x}px;top:${f.cloud.y}px;width:${f.cloud.w}px}
  .cloudStack{top:${r2(G.stackTop)}px;--ox:${r2(G.ox)}%;--oy:${r2(G.oy)}%}
  .fog img{filter:blur(${r2(22 * G.cs)}px)}
  .flash{width:${r2(260 * G.cs)}px;height:${r2(260 * G.cs)}px;margin:${r2(-130 * G.cs)}px 0 0 ${r2(-130 * G.cs)}px}
  .girl{left:${f.girl.x}px;top:${f.girl.y}px;width:${f.girl.w}px}
  /* girl = true-colour JPEG + alpha mask; the shadow sits on a static wrapper so it is painted once */
  .girl .gs{filter:drop-shadow(0 30px 30px rgba(0,20,60,.35))}
  .girl img{filter:none;-webkit-mask-image:url(girl-a.png);mask-image:url(girl-a.png);
    -webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}
  .pair{left:${r2(G.foot[0] - 375 * G.gs)}px;top:${r2(G.foot[1] - 125 * G.gs)}px;width:${r2(750 * G.gs)}px;height:${r2(250 * G.gs)}px}
  .floorGlow{left:${r2(G.foot[0])}px;top:${r2(G.foot[1])}px;width:${r2(700 * G.gs)}px;height:${r2(190 * G.gs)}px}
  .cta{left:${f.cta.x - 14}px;top:${f.cta.y - 14}px;cursor:pointer}
  .ctaBody{height:${c.h}px;padding:0 ${c.padR}px 0 ${c.padL}px;gap:${c.gap}px;font-size:${f.cta.font}px}
  .ctaBody svg{width:${c.arrowW}px;height:${c.arrowH}px}
  .ctaGlow{box-shadow:0 0 ${r2(28 * c.g)}px ${r2(8 * c.g)}px rgba(220,255,70,.8),0 0 ${r2(56 * c.g)}px ${r2(16 * c.g)}px rgba(110,210,255,.35)}
  @keyframes ctaIn{
    0%  {opacity:0;transform:translateX(${-Math.round(f.cta.x + c.w + 60)}px) skewX(-14deg);animation-timing-function:cubic-bezier(.15,.85,.3,1)}
    15% {opacity:1}
    68% {opacity:1;transform:translateX(${r2(18 * c.g)}px) skewX(5deg);animation-timing-function:ease-in-out}
    100%{opacity:1;transform:translateX(0) skewX(0)}
  }
  /* "de la" as live text: the baked-in one is ~5 px tall at this size, unreadable */
  .deLa{position:absolute;left:13%;top:40.4%;transform:translate(-50%,-50%) rotate(-8deg);white-space:nowrap;
    padding:.2em .5em .24em;border-radius:1em;background:rgba(11,26,51,.86);color:#fff;letter-spacing:.01em;
    font:800 ${f.deLa.font}px/1 Montserrat,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
    box-shadow:0 2px 6px rgba(0,20,60,.35)}
  /* advertiser identification on the final frame (Google Ads "Unidentified business" policy) */
  .adLabel{position:absolute;${labelPos};pointer-events:none;color:#fff;letter-spacing:.02em;
    font:800 ${L.font}px/1 Montserrat,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
    text-shadow:0 2px 6px rgba(0,20,60,.55),0 0 2px rgba(0,20,60,.4)}
`;
}

function html(f, G) {
  let s = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  s = rep(s, '<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="ad.size" content="width=${f.w},height=${f.h}">`);
  s = rep(s, 'text=Conecteaz%C4%83-te%20acum&', 'text=Conecteaz%C4%83-te%20acum%20arax.md%20de%20la&', 'font subset');
  s = rep(s, 'assets/bg.png', 'bg.jpg');
  s = rep(s, 'assets/cloud.png', 'cloud.png');
  s = rep(s, '<div class="girl"><img src="assets/girl.png" alt=""></div>',
    '<div class="girl"><div class="gs"><img src="girl.jpg" alt=""></div></div>', 'girl');
  s = rep(s, '<div class="cl sharp"><img src="cloud.png" alt="internet de la 69 lei"></div>',
    '<div class="cl sharp"><img src="cloud.png" alt="internet de la 69 lei"><span class="deLa">de la</span></div>', 'sharp layer');
  // Google Ads makes the whole ad clickable to the final URL set in the ad; own exits are not allowed
  s = rep(s, '<a class="cta" href="https://arax.md" target="_blank" rel="noopener">', '<div class="cta">', 'cta link');
  s = rep(s, '    </a>\n   </div>', '    </div>\n\n    <div class="adLabel">arax.md</div>\n   </div>', 'cta end');
  s = rep(s, '</style>\n</head>', css(f, G) + '</style>\n</head>', 'style end');
  const cfg = { W: SW, H: r2(G.H), leaves: f.leaves, burst: r2(G.cs), stopAt: STOP_AT, debugParam: '__arax_t', preload: ['girl-a.png'] };
  s = rep(s, '<script>\n(function(){', `<script>window.AD_CFG=${JSON.stringify(cfg)};</script>\n<script>\n(function(){`, 'main script');
  return s;
}

// Transparent pixels get the colour of the nearest opaque area, so the JPEG has no dark fringe under the soft mask edge.
function bleed(data, W, H) {
  const n = W * H, pre = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = data[i * 4] * a; pre[i * 4 + 1] = data[i * 4 + 1] * a; pre[i * 4 + 2] = data[i * 4 + 2] * a; pre[i * 4 + 3] = a;
  }
  const blur = (src, r) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length), cl = (v, m) => v < 0 ? 0 : v > m ? m : v;
    for (let y = 0; y < H; y++) for (let c = 0; c < 4; c++) {
      let acc = 0; for (let x = -r; x <= r; x++) acc += src[(y * W + cl(x, W - 1)) * 4 + c];
      for (let x = 0; x < W; x++) { tmp[(y * W + x) * 4 + c] = acc; acc += src[(y * W + cl(x + r + 1, W - 1)) * 4 + c] - src[(y * W + cl(x - r, W - 1)) * 4 + c]; }
    }
    for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) {
      let acc = 0; for (let y = -r; y <= r; y++) acc += tmp[(cl(y, H - 1) * W + x) * 4 + c];
      for (let y = 0; y < H; y++) { out[(y * W + x) * 4 + c] = acc; acc += tmp[(cl(y + r + 1, H - 1) * W + x) * 4 + c] - tmp[(cl(y - r, H - 1) * W + x) * 4 + c]; }
    }
    return out;
  };
  const near = blur(pre, 6), far = blur(pre, 40);
  const rgb = Buffer.alloc(n * 3), alpha = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3]; alpha[i] = a;
    for (let c = 0; c < 3; c++) {
      let v;
      if (a > 0) v = data[i * 4 + c];
      else if (near[i * 4 + 3] > 1e-3) v = near[i * 4 + c] / near[i * 4 + 3];
      else if (far[i * 4 + 3] > 1e-3) v = far[i * 4 + c] / far[i * 4 + 3];
      else v = 150;
      rgb[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return { rgb, alpha };
}

function ownBackground(f) {
  if (f.bg) {                                    // explicit per version
    const p = path.join(ROOT, f.bg);
    if (!fs.existsSync(p)) throw new Error(`${f.id}: background not found: ${f.bg}`);
    return p;
  }
  const bgW = f.w * BG_DENSITY, bgH = f.h * BG_DENSITY;
  // otherwise google/src/bg-300x250.jpg, or the single assets/bg-600x500*.jpg (the 2x size in the name)
  const src = ['png', 'jpg', 'jpeg'].map(e => path.join(SRC, `bg-${f.id}.${e}`)).find(p => fs.existsSync(p));
  if (src) return src;
  const found = fs.readdirSync(path.join(ROOT, 'assets')).filter(n => n.startsWith(`bg-${bgW}x${bgH}`) && /\.(png|jpe?g)$/i.test(n));
  if (found.length > 1) throw new Error(`${f.id}: several backgrounds match (${found.join(', ')}), set "bg" for this version`);
  return found[0] && path.join(ROOT, 'assets', found[0]);
}

async function images(f, G, dir, q) {
  const notes = [];
  // background: exact ad size at 2x, JPEG with full colour resolution
  const bgW = f.w * BG_DENSITY, bgH = f.h * BG_DENSITY, own = ownBackground(f);
  notes.push(own ? 'background: ' + path.relative(ROOT, own).split(path.sep).join('/') : 'PLACEHOLDER background cut from assets/bg.png');
  let bg = sharp(own || path.join(ROOT, 'assets', 'bg.png')).resize(bgW, bgH, { fit: 'cover', position: own ? 'centre' : f.placeholderPosition });
  if (f.shade) bg = bg.composite([{ input: shadeSVG(bgW, bgH, f.shade), top: 0, left: 0 }]);
  await bg.jpeg({ quality: q.bgQ, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(path.join(dir, 'bg.jpg'));
  // girl: true-colour JPEG + alpha mask (palette PNG of one colour with 256 alpha levels: exact and small)
  const girlPx = Math.round(f.girl.w * G.scale * q.girlD);
  const { data, info } = await sharp(path.join(ROOT, 'assets', 'girl.png')).resize({ width: girlPx }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { rgb, alpha } = bleed(data, info.width, info.height);
  await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
    .jpeg({ quality: q.girlQ, mozjpeg: true, chromaSubsampling: '4:4:4' }).toFile(path.join(dir, 'girl.jpg'));
  const mask = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < alpha.length; i++) mask[i * 4 + 3] = alpha[i];
  await sharp(mask, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ palette: true, quality: 100, dither: 0, effort: 10, compressionLevel: 9 }).toFile(path.join(dir, 'girl-a.png'));
  // clouds: palette PNG keeps the transparency and is near-lossless for this white/blue art
  const cloudPx = Math.round(f.cloud.w * G.scale * q.cloudD);
  await sharp(await cloudWithoutDeLa(), { raw: { width: CLOUD.w, height: CLOUD.h, channels: 4 } }).resize({ width: cloudPx })
    .png({ palette: true, quality: 100, effort: 10, compressionLevel: 9 }).toFile(path.join(dir, 'cloud.png'));
  return notes;
}

let cloudRaw = null;
async function cloudWithoutDeLa() {
  if (cloudRaw) return cloudRaw;
  const { data, info } = await sharp(path.join(ROOT, 'assets', 'cloud.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== CLOUD.w || info.height !== CLOUD.h) throw new Error('assets/cloud.png size changed');
  const [wx0, wy0, wx1, wy1] = CLOUD.deLa.window, [rx0, ry0, rx1, ry1] = CLOUD.deLa.rect;
  const W = wx1 - wx0, H = wy1 - wy0, A = (x, y) => data[(y * info.width + x) * 4 + 3];
  // label opaque blobs in the window; the glyphs are the small blobs that sit fully inside the erase box
  const lab = new Int32Array(W * H), keep = new Set();
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lab[y * W + x] || A(x + wx0, y + wy0) <= 40) continue;
    n++; const st = [y * W + x]; lab[y * W + x] = n; let x0 = x, x1 = x, y0 = y, y1 = y, cnt = 0;
    while (st.length) {
      const j = st.pop(), jx = j % W, jy = (j / W) | 0; cnt++;
      x0 = Math.min(x0, jx); x1 = Math.max(x1, jx); y0 = Math.min(y0, jy); y1 = Math.max(y1, jy);
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = jx + ax, ny = jy + ay; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = ny * W + nx; if (!lab[k] && A(nx + wx0, ny + wy0) > 40) { lab[k] = n; st.push(k); }
      }
    }
    const inside = x0 + wx0 >= rx0 && x1 + wx0 <= rx1 && y0 + wy0 >= ry0 && y1 + wy0 <= ry1 && cnt < 2000;
    if (!inside) keep.add(n);          // the swoosh and the 6 stay
  }
  let erased = 0;
  for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
    const l = lab[(y - wy0) * W + (x - wx0)];
    if (l && keep.has(l)) continue;
    data[(y * info.width + x) * 4 + 3] = 0; erased++;
  }
  if (erased < 500) throw new Error('"de la" not found in assets/cloud.png');
  return (cloudRaw = data);
}

function zip(dir, file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${dir.replace(/'/g, "''")}\\*' -DestinationPath '${file.replace(/'/g, "''")}' -Force`], { stdio: 'pipe' });
  return fs.statSync(file).size;
}

function validate(f, G, dir, zipSize) {
  const problems = [];
  const files = fs.readdirSync(dir);
  if (files.length > MAX_FILES) problems.push(`too many files: ${files.length}`);
  for (const n of files) {
    if (!ALLOWED_EXT.has(path.extname(n).toLowerCase())) problems.push(`file type not allowed: ${n}`);
    if (!/^[A-Za-z0-9._-]+$/.test(n)) problems.push(`bad file name: ${n}`);
  }
  const htmls = files.filter(n => n.toLowerCase().endsWith('.html'));
  if (htmls.length !== 1) problems.push(`expected exactly one .html, found ${htmls.length}`);
  const s = fs.readFileSync(path.join(dir, htmls[0]), 'utf8');
  if (!s.includes(`<meta name="ad.size" content="width=${f.w},height=${f.h}">`)) problems.push('ad.size meta missing');
  if (!/^<!DOCTYPE html>/i.test(s) || !/<html[\s>]/i.test(s) || !/<body[\s>]/i.test(s)) problems.push('doctype/html/body missing');
  for (const m of s.matchAll(/https?:\/\/([^\/\s"'<>)]+)/g)) if (!ALLOWED_HOSTS.includes(m[1])) problems.push(`external reference: ${m[0]}`);
  if (/<a\s[^>]*href=/i.test(s)) problems.push('own click-through link present');
  if (/localStorage|sessionStorage|indexedDB/.test(s)) problems.push('storage API used');
  for (const ref of ['bg.jpg', 'girl.jpg', 'girl-a.png', 'cloud.png']) if (!files.includes(ref)) problems.push(`missing asset: ${ref}`);
  if (zipSize > MAX_ZIP) problems.push(`zip too big: ${(zipSize / 1000).toFixed(1)} KB > ${MAX_ZIP / 1000} KB`);
  if (f.cta.x + G.cta.w + 24 > G.legX) problems.push(`CTA (${Math.round(f.cta.x + G.cta.w)}) runs into the standing leg (${Math.round(G.legX)})`);
  return { files, problems };
}

(async () => {
  fs.mkdirSync(DIST, { recursive: true });
  const report = [];
  for (const f of FORMATS) {
    const G = geometry(f);
    const dir = path.join(DIST, f.id);
    const zipFile = path.join(DIST, `arax-toamna-${f.id}.zip`);
    let zipSize = 0, notes = [], rung = -1;
    for (let i = 0; i < QUALITY_LADDER.length; i++) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html(f, G));
      notes = await images(f, G, dir, QUALITY_LADDER[i]);
      zipSize = zip(dir, zipFile);
      rung = i;
      if (zipSize <= TARGET_ZIP) break;
    }
    const { files, problems } = validate(f, G, dir, zipSize);
    const sizes = Object.fromEntries(files.map(n => [n, kb(fs.statSync(path.join(dir, n)).size)]));
    report.push({ format: f.id, w: f.w, h: f.h, zip: kb(zipSize), zipBytes: zipSize, ok: problems.length === 0, quality: { rung, ...QUALITY_LADDER[rung] }, problems, notes, sizes });
  }
  fs.writeFileSync(path.join(DIST, 'report.json'), JSON.stringify(report, null, 2));
  for (const r of report) {
    const q = r.quality;
    console.log(`\n${r.format}: zip ${r.zip} (${r.zipBytes} bytes)  ${r.ok ? 'OK' : 'PROBLEMS'}  quality rung ${q.rung}: bg q${q.bgQ}, girl ${q.girlD}x q${q.girlQ}, clouds ${q.cloudD}x`);
    for (const [n, s] of Object.entries(r.sizes)) console.log(`   ${n.padEnd(12)} ${s}`);
    for (const p of r.problems) console.log('   ! ' + p);
    for (const n of r.notes) console.log('   * ' + n);
  }
  if (report.some(r => !r.ok)) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
