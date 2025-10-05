// =======================================
// VidShrink — main client script (clean)
// =======================================

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

const year = document.getElementById('year');
if (year) year.textContent = new Date().getFullYear();

// === State ===
let videoFile   = null;      // holds the picked file (image or video)
let estBytes    = null;      // estimated output bytes (from preset)
let currentMode = 'video';   // 'video' | 'photo'

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
  if (!videoFile) return;
  estBytes = estimateOutputBytes(videoFile.size, presetSel.value);
  estEl.textContent = '≈ ' + formatBytes(estBytes);
  saveRow?.classList.add('hidden');
  saveEl.textContent = '—';
}

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

  result.classList.remove('hidden');
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

  const dl = document.getElementById('downloadLink');
  dl.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 3000));

  const sb = document.getElementById('shareBtn');
  if (sb) {
    sb.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [new File([outBlob], filename, { type: mime })] });
      } catch {/* user cancelled */}
    });
  }
}

// -----------------------------------------------------
//  FFmpeg loader (videos) — single definition
// -----------------------------------------------------
let ffmpeg;       // instance
let ffmpegReady = false;

async function ensureFFmpeg() {
  if (ffmpegReady) return;

  // Wrapper must be added in index.html:
  // <script src="https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.7/dist/ffmpeg.min.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
  if (!window.FFmpeg) {
    throw new Error('FFmpeg wrapper not found on window. Check the <script> in index.html.');
  }

  const { createFFmpeg, fetchFile } = window.FFmpeg;

  const corePath =
    window.__FFMPEG_CORE_PATH ||
    "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.7/dist/ffmpeg-core.js";

  ffmpeg = createFFmpeg({
    log: false,
    corePath
  });

  try {
    await ffmpeg.load();
  } catch (e) {
    console.error('FFmpeg load error:', e);
    throw new Error('Failed to load FFmpeg core (network/ad blocker?).');
  }

  // expose helper for use in compressVideo
  ensureFFmpeg.fetchFile = fetchFile;
  ffmpegReady = true;
}

// -----------------------------------------------------
//  Preset → args & compressVideo
// -----------------------------------------------------

function presetToFFmpegArgs(preset, inputW = null, inputH = null) {
  let vf = [];
  let crf = 23;  // higher = smaller
  let maxW = null;

  if (preset === 'same') {
    crf = 23;                 // ~25% smaller
  } else if (preset === 'small') {
    crf = 28; maxW = 1080;    // ~45–55% smaller
  } else if (preset === 'smallest') {
    crf = 30; maxW = 720;     // ~75% smaller
  }

  if (maxW && inputW && inputH && inputW > maxW) {
    // keep AR; ensure divisible by 2
    vf = ['-vf', `scale='min(${maxW},iw)':'-2'`];
  }

  return [
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', 'veryfast',
    ...vf,
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k'
  ];
}

async function compressVideo(file, preset) {
  await ensureFFmpeg();
  const { fetchFile } =
