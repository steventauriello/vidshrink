// =======================================
// VidShrink — main client script (clean)
// =======================================
// --- ffmpeg config (no inline scripts needed) ---
window.__FFMPEG_CORE_PATH = "/assets/ffmpeg/ffmpeg-core.js";
if (typeof window.FFmpeg === "undefined" && typeof FFmpeg !== "undefined") {
  window.FFmpeg = FFmpeg;
}


// === DOM refs ===
const fileInput  = document.getElementById('file');
const pickBtn    = document.getElementById('pick');
const drop       = document.getElementById('drop');
const options    = document.getElementById('options');
const startBtn   = document.getElementById('start');
const resetBtn   = document.getElementById('reset');
const progBar    = document.getElementById('progBar');
const progWrap   = document.getElementById('progWrap');
const progText   = document.getElementById('progText');
const result     = document.getElementById('result');
const presetSel  = document.getElementById('preset');

const origEl     = document.getElementById('orig');
const estEl      = document.getElementById('est');
const saveRow    = document.getElementById('savingsRow');
const saveEl     = document.getElementById('save');

const modeVideo  = document.getElementById('modeVideo');
const modePhoto  = document.getElementById('modePhoto');

const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// --- iOS-safe picker button ---
pickBtn?.addEventListener('click', () => {
  if (!fileInput) return;
  fileInput.value = ''; // allow re-selecting same file
  try {
    if (typeof fileInput.showPicker === 'function') {
      fileInput.showPicker();
      return;
    }
  } catch {}
  fileInput.click();
});

// --- Mode setup: keep accept + labels in sync ---
let currentMode = 'video';
function setMode(mode) {
  currentMode = mode;
  const isVideo = mode === 'video';
  modeVideo?.classList.toggle('selected', isVideo);
  modePhoto?.classList.toggle('selected', !isVideo);
  if (fileInput) fileInput.accept = isVideo ? 'video/*' : 'image/*';
  if (pickBtn)   pickBtn.textContent = isVideo ? 'Choose Video' : 'Choose Photo';
  if (startBtn)  startBtn.textContent = isVideo ? 'Compress Video' : 'Compress Photo';
}
modeVideo?.addEventListener('click', () => setMode('video'));
modePhoto?.addEventListener('click', () => setMode('photo'));
setMode('video'); // initial state

// === State ===
let pickedFile = null;  // image OR video
let estBytes   = null;  // estimated output bytes

// === Helpers ===
const MB = 1024 * 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const val = bytes / MB;
  return (val >= 100 ? val.toFixed(0) : val.toFixed(1)) + ' MB';
}

function estimateOutputBytes(inputBytes, preset) {
  const ratios = { same: 0.75, small: 0.55, smallest: 0.25 };
  const r = ratios[preset] ?? ratios.small;
  return Math.max(0.9 * MB, Math.round(inputBytes * r));
}

function updateEstimate() {
  if (!pickedFile) return;
  estBytes = estimateOutputBytes(pickedFile.size, presetSel?.value);
  if (estEl) estEl.textContent = '≈ ' + formatBytes(estBytes);
  saveRow?.classList.add('hidden');
  if (saveEl) saveEl.textContent = '—';
}

// Wire the dropdown so estimates actually change
presetSel?.addEventListener('change', updateEstimate);

// Output filename helper
function makeOutName(inputName, mode = 'video') {
  const dot = inputName.lastIndexOf('.');
  const stem = dot > -1 ? inputName.slice(0, dot) : inputName;
  const ext  = (mode === 'photo') ? '.jpg' : '.mp4';
  return `${stem}-shrink${ext}`;
}

// Inject result UI + wire buttons
function renderResult(outBlob, filename, mime) {
  const url = URL.createObjectURL(outBlob);
  const canShareFiles = !!(
    navigator.canShare &&
    navigator.canShare({ files: [new File([outBlob], filename, { type: mime })] })
  );

  const shareBtnHTML = canShareFiles
    ? `<button id="shareBtn" class="btn primary" type="button" style="margin-right:.5rem">Save to Photos</button>`
    : '';

  result?.classList.remove('hidden');
  if (result) {
    result.innerHTML = `
      <p>✅ Compression complete.</p>
      <p class="mono" style="margin-bottom:.5rem"></p>
      <div style="display:flex; flex-wrap:wrap; gap:.5rem; align-items:center">
        ${shareBtnHTML}
        <a id="downloadLink" class="btn" href="${url}" download="${filename}">Download</a>
        <span class="mono" style="margin-left:.25rem; opacity:.85">${filename}</span>
      </div>
      <p class="mono" style="margin-top:.5rem">Tip: On iPhone/Android, “Save to Photos” opens the Share sheet so you can save directly into your library.</p>
    `;
  }

  const dl = document.getElementById('downloadLink');
  dl?.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 3000));

  const sb = document.getElementById('shareBtn');
  sb?.addEventListener('click', async () => {
    try {
      await navigator.share({ files: [new File([outBlob], filename, { type: mime })] });
    } catch {/* user cancelled */}
  });
}

// -----------------------------------------------------
//  FFmpeg loader (videos)
// -----------------------------------------------------
let ffmpeg;
let ffmpegReady = false;

async function ensureFFmpeg() {
  if (ffmpegReady) return;

  // Robust global lookup (UMD may attach different names)
  const FF =
    window.FFmpeg ??
    globalThis.FFmpeg ??
    globalThis.ffmpeg ??
    (globalThis.__FFmpeg || null);

  if (!FF) {
    throw new Error('FFmpeg wrapper not found — make sure /assets/ffmpeg/ffmpeg.min.js loads BEFORE app.js');
  }

  const { createFFmpeg, fetchFile } = FF;

  // Always use your self-hosted core (no CDN fallback)
  const corePath = window.__FFMPEG_CORE_PATH || "/assets/ffmpeg/ffmpeg-core.js";

  // Optional: quick reachability probe (helps diagnose path/headers)
  try {
    const head = await fetch(corePath, { method: 'HEAD' });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
  } catch {
    throw new Error(`Can't fetch ffmpeg-core.js at ${corePath}`);
  }

  ffmpeg = createFFmpeg({ log: true, corePath });
  try { ffmpeg.setLogger?.(({ type, message }) => console.log(`[ffmpeg:${type}]`, message)); } catch {}

  try {
    await ffmpeg.load();
  } catch (e) {
    console.error('FFmpeg load error:', e);
    throw new Error('Failed to load FFmpeg core (check ffmpeg-core.wasm/worker + WASM MIME).');
  }

  ensureFFmpeg.fetchFile = fetchFile;
  ffmpegReady = true;
}

// -----------------------------------------------------
//  Preset → args & compressVideo
// -----------------------------------------------------
function presetToFFmpegArgs(preset) {
  let crf = 23;            // higher = smaller
  let maxW = null;

  if (preset === 'same')       { crf = 23; }
  else if (preset === 'small') { crf = 28; maxW = 1080; }
  else if (preset === 'smallest') { crf = 30; maxW = 720; }

  // Always include scale when maxW is set; ffmpeg calculates min() itself.
  const vf = maxW ? ['-vf', `scale=min(${maxW},iw):-2`] : [];

  return [
    // (optional mapping added below in the "nice-to-have" section)
    '-pix_fmt','yuv420p',
    '-c:v','libx264',
    '-crf', String(crf),
    '-preset','veryfast',
    ...vf,
    '-movflags','+faststart',
    '-c:a','aac','-b:a','128k'
  ];
}

async function compressVideo(file, preset) {
  await ensureFFmpeg();
  const { fetchFile } = ensureFFmpeg;

  const inName  = 'input.' + (file.name.split('.').pop() || 'mp4');
  const outName = 'output.mp4';

  // Write to FS
  ffmpeg.FS('writeFile', inName, await fetchFile(file));

  // Progress
  ffmpeg.setProgress(({ ratio }) => {
    const pct = Math.min(99, Math.floor((ratio || 0) * 100));
    progBar && (progBar.style.width = pct + '%');
    progText && (progText.textContent = `Compressing… ${pct}%`);
  });

  // Run
  const args = ['-i', inName, ...presetToFFmpegArgs(preset), outName];
  await ffmpeg.run(...args);

  // Read output — Blob from Uint8Array (not data.buffer) for iOS
  const data = ffmpeg.FS('readFile', outName);
  const blob = new Blob([data], { type: 'video/mp4' });

  // Cleanup
  try { ffmpeg.FS('unlink', inName); } catch {}
  try { ffmpeg.FS('unlink', outName); } catch {}

  if (!blob.size) throw new Error('Encoding produced an empty file (check input format or preset).');
  return blob;
}

// -----------------------------------------------------
//  Image compression (auto-ensure output is smaller)
// -----------------------------------------------------
async function compressImage(file, preset) {
  const isHEIC = /image\/hei(c|f)/i.test(file.type);
  const isPNG  = /image\/png/i.test(file.type);
  const isJPG  = /image\/jpe?g/i.test(file.type);

  // Preset knobs
  const cfgMap = {
    same:     { maxW: null,  target: 0.80, qStart: isHEIC ? 0.70 : 0.85, qMin: 0.60 },
    small:    { maxW: 1280,  target: 0.55, qStart: isHEIC ? 0.60 : 0.78, qMin: 0.50 },
    smallest: { maxW:  720,  target: 0.30, qStart: isHEIC ? 0.50 : 0.66, qMin: 0.40 },
  };
  const cfg = cfgMap[preset] || cfgMap.small;

  // Never promise more than reality; leave at least 20 KB reduction target.
  const targetBytes = Math.min(Math.round(file.size * cfg.target), file.size - 20 * 1024);

  // Decode
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  URL.revokeObjectURL(url);

  // Size
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (cfg.maxW && w > cfg.maxW) {
    const s = cfg.maxW / w;
    w = Math.round(cfg.maxW);
    h = Math.round(h * s);
  }

  // Canvas
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  function drawToCanvas() {
    canvas.width = w; canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
  }
  drawToCanvas();

  const encode = (q) => new Promise((res) => {
    // Always export JPEG (widely supported); Safari uses sane subsampling.
    canvas.toBlob(res, 'image/jpeg', q);
  });

  // 1) Try decreasing quality until we hit targetBytes (or qMin)
  let q = cfg.qStart;
  let outBlob = await encode(q);

  while (outBlob && outBlob.size > targetBytes && q > cfg.qMin) {
    q = Math.max(cfg.qMin, q - 0.05);
    outBlob = await encode(q);
  }

  // 2) If still not smaller than original, do a light downscale + retry once
  if (outBlob && outBlob.size >= file.size) {
    // If we didn’t already downscale via preset, shrink ~10%
    if (!cfg.maxW || img.naturalWidth <= cfg.maxW) {
      w = Math.round(w * 0.9);
      h = Math.round(h * 0.9);
      drawToCanvas();
    }
    q = Math.max(cfg.qMin, q - 0.10);
    outBlob = await encode(q);
  }

  // 3) Final guardrail: if still not smaller, return the original file
  if (!outBlob || outBlob.size >= file.size) {
    return file;
  }
  return outBlob;
}

// -----------------------------------------------------
//  File picking & DnD
// -----------------------------------------------------
fileInput?.addEventListener('change', e => handleFile(e.target.files[0]));

drop?.addEventListener('dragover', e => {
  e.preventDefault();
  drop.classList.add('dragover');
});
drop?.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop?.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  pickedFile = file;

  const inner = document.querySelector('.drop-inner');
  if (inner) inner.innerHTML = `<p><strong>${file.name}</strong> (${formatBytes(file.size)})</p>`;

  options?.classList.remove('hidden');
  if (origEl) origEl.textContent = formatBytes(file.size);
  updateEstimate();
}

// -----------------------------------------------------
//  Start compression
// -----------------------------------------------------
startBtn?.addEventListener('click', async () => {
  if (!pickedFile) return;

  result?.classList.add('hidden');
  if (result) result.innerHTML = '';

  progWrap?.classList.remove('hidden');
  if (progBar) progBar.style.width = '0%';
  if (progText) progText.textContent = 'Preparing…';

  try {
    let outBlob, mime;
    const preset = presetSel?.value || 'small';

    if (currentMode === 'photo') {
      mime = 'image/jpeg';

      // small progress shim so photos don't look idle
      for (let w = 0; w <= 25; w += 5) {
        await new Promise(r => setTimeout(r, 25));
        if (progBar) progBar.style.width = `${w}%`;
        if (progText) progText.textContent = `Compressing… ${w}%`;
      }

      outBlob = await compressImage(pickedFile, preset);
    } else {
      mime = 'video/mp4';
      outBlob = await compressVideo(pickedFile, preset);
    }

    if (progBar) progBar.style.width = '100%';
    if (progText) progText.textContent = 'Done!';

    const outBytes   = outBlob.size ?? estBytes ?? pickedFile.size;
    const savedBytes = Math.max(0, pickedFile.size - outBytes);
    const savedPct   = pickedFile.size > 0
      ? Math.round((savedBytes / pickedFile.size) * 100)
      : 0;

    saveRow?.classList.remove('hidden');
    if (saveEl) {
      saveEl.textContent =
        `${savedPct}% saved (${formatBytes(pickedFile.size)} → ${formatBytes(outBytes)})`;
    }

    const outName = makeOutName(pickedFile.name, currentMode);
    renderResult(outBlob, outName, mime);   // buttons handle share/download

    // Update the percent line inside the result panel
    const pcts = result?.querySelector('p.mono');
    if (pcts) {
      pcts.textContent =
        `${savedPct}% saved (${formatBytes(pickedFile.size)} → ${formatBytes(outBytes)})`;
    }

  } catch (err) {
    console.error(err);
    if (progText) {
      const msg = (err && err.message) ? String(err.message) : 'Something went wrong.';
      progText.textContent = msg;
    }
  }
});