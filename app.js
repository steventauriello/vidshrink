// =======================================
// VidShrink — main client script
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
  // top = biggest output, middle = medium, bottom = smallest
  const ratios = {
    same:      0.75, // ~25% smaller
    small:     0.55, // ~45–55% smaller
    smallest:  0.25  // ~75% smaller
  };
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
      } catch {
        /* user cancelled */
      }
    });
  }
}

// -----------------------------------------------------
// -----------------------------------------------------
//  FFmpeg loader (for videos) - version-locked
// -----------------------------------------------------
let ffmpeg;       // instance
let ffmpegReady = false;

async function ensureFFmpeg() {
  if (ffmpegReady) return;

  // We rely on the wrapper script tag you load in index.html:
  // <script src="https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.7/dist/ffmpeg.min.js"></script>
  if (!window.FFmpeg) {
    throw new Error('FFmpeg wrapper not found on window. Check the <script> tag in index.html.');
  }

  const { createFFmpeg, fetchFile } = window.FFmpeg;

  ffmpeg = createFFmpeg({
    log: false,
    // IMPORTANT: core version & CDN must match the wrapper above
    corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.7/dist/ffmpeg-core.js'
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
//  Your provided blocks: preset → args & compressVideo
// -----------------------------------------------------

// Preset → ffmpeg options
function presetToFFmpegArgs(preset, inputW = null, inputH = null) {
  // Defaults that look good on phones and social
  // You can tweak CRF (lower = better quality, larger file)
  let vf = [];
  let crf = 23;         // best quality (same)
  let maxW = null;      // width cap used in "smallest"

  if (preset === 'same') {
    crf = 23; // ~25% smaller
  } else if (preset === 'small') {
    crf = 28; // ~45–55% smaller
    maxW = 1080;        // scale down if larger
  } else if (preset === 'smallest') {
    crf = 30; // ~75% smaller
    maxW = 720;
  }

  if (maxW && inputW && inputH && inputW > maxW) {
    // keep aspect ratio, width multiple of 2 for H.264
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

  const { fetchFile } = ensureFFmpeg;

  // Write input to FFmpeg FS
  const inName  = 'input.' + (file.name.split('.').pop() || 'mp4');
  const outName = 'output.mp4';
  ffmpeg.FS('writeFile', inName, await fetchFile(file));

  // Use args based on preset
  const args = ['-i', inName, ...presetToFFmpegArgs(preset), outName];

  // Show encoding progress in the existing bar
  ffmpeg.setProgress(({ ratio }) => {
    const pct = Math.min(99, Math.floor((ratio || 0) * 100));
    progBar.style.width = pct + '%';
    progText.textContent = `Compressing… ${pct}%`;
  });

  await ffmpeg.run(...args);

  // Read output back
  const data = ffmpeg.FS('readFile', outName);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });

  // Clean up FS
  try { ffmpeg.FS('unlink', inName); } catch {}
  try { ffmpeg.FS('unlink', outName); } catch {}

  return blob;
}

// -----------------------------------------------------
//  Image compression (canvas → JPEG)
// -----------------------------------------------------
async function compressImage(file, preset) {
  const map = {
    same:      { maxW: null, quality: 0.9 },
    small:     { maxW: 1080, quality: 0.78 },
    smallest:  { maxW: 720,  quality: 0.66 }
  };
  const { maxW, quality } = map[preset] ?? map.small;

  // Load image
  const blobURL = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = blobURL;
  await img.decode();

  // Compute size
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (maxW && w > maxW) {
    const scale = maxW / w;
    w = Math.round(maxW);
    h = Math.round(h * scale);
  }

  // Draw
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(blobURL);

  // Export JPEG
  const outBlob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return outBlob || file; // fallback
}

// -----------------------------------------------------
//  File picking & DnD
// -----------------------------------------------------
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

drop.addEventListener('dragover', e => {
  e.preventDefault();
  drop.classList.add('dragover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  videoFile = file;

  document.querySelector('.drop-inner').innerHTML =
    `<p><strong>${file.name}</strong> (${formatBytes(file.size)})</p>`;

  options.classList.remove('hidden');
  origEl.textContent = formatBytes(file.size);
  updateEstimate();
}

// -----------------------------------------------------
//  Mode Switching
// -----------------------------------------------------
modeVideo.addEventListener('click', () => {
  currentMode = 'video';
  modeVideo.classList.add('selected');
  modePhoto.classList.remove('selected');
  fileInput.accept = 'video/*';
  pickBtn.textContent = 'Choose Video';
  startBtn.textContent = 'Compress Video';
});

modePhoto.addEventListener('click', () => {
  currentMode = 'photo';
  modePhoto.classList.add('selected');
  modeVideo.classList.remove('selected');
  fileInput.accept = 'image/*';
  pickBtn.textContent = 'Choose Photo';
  startBtn.textContent = 'Compress Photo';
});

// Preset change
presetSel.addEventListener('change', updateEstimate);

// -----------------------------------------------------
//  Start compression
// -----------------------------------------------------
startBtn.addEventListener('click', async () => {
  if (!videoFile) return;

  // reset previous result
  result.classList.add('hidden');
  result.innerHTML = '';

  // show progress UI
  progWrap.classList.remove('hidden');
  progBar.style.width = '0%';
  progText.textContent = 'Preparing…';

  // Estimate & savings UI updates occur after we get the output
  try {
    // Do the actual work
    let outBlob, mime;
    const preset = presetSel.value;

    if (currentMode === 'photo') {
      mime = 'image/jpeg';
      // quick fake progress for nicer UX while we work
      for (let w = 0; w <= 25; w += 5) {
        await new Promise(r => setTimeout(r, 25));
        progBar.style.width = `${w}%`;
        progText.textContent = `Compressing… ${w}%`;
      }
      outBlob = await compressImage(videoFile, preset);
      progBar.style.width = '100%';
      progText.textContent = 'Done!';
    } else {
      mime = 'video/mp4';
      outBlob = await compressVideo(videoFile, preset); // FFmpeg handles progress bar updates
      progBar.style.width = '100%';
      progText.textContent = 'Done!';
    }

    // Savings line
    const outBytes = estBytes ?? outBlob.size ?? videoFile.size;
    const savedBytes = Math.max(0, videoFile.size - outBytes);
    const savedPct = videoFile.size > 0
      ? Math.round((savedBytes / videoFile.size) * 100)
      : 0;

    saveRow?.classList.remove('hidden');
    saveEl.textContent =
      `${savedPct}% saved (${formatBytes(videoFile.size)} → ${formatBytes(outBytes)})`;

    // Result UI + auto open share
    const outName = makeOutName(videoFile.name, currentMode);
    renderResult(outBlob, outName, mime);

    // Auto-open share sheet or fallback download
    try {
      const f = new File([outBlob], outName, { type: mime });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({
          files: [f],
          title: 'Your compressed file is ready',
          text: 'Choose where to save or share your new file.'
        });
      } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(outBlob);
        link.download = outName;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
          URL.revokeObjectURL(link.href);
          link.remove();
        }, 2000);
      }
    } catch (err) {
      console.error('Share/download error:', err);
    }

    // Put % saved into the first mono <p> in the result panel
    const pcts = result.querySelector('p.mono');
    if (pcts) {
      pcts.textContent = `${savedPct}% saved (${formatBytes(videoFile.size)} → ${formatBytes(outBytes)})`;
    }
  } catch (err) {
    console.error(err);
    progText.textContent = 'Something went wrong.';
  }
});

// Reset
resetBtn.addEventListener('click', () => location.reload());
/* ===========================
   VidShrink – FFmpeg patch
   Paste at the very bottom of app.js
   =========================== */
(() => {
  if (window.__VS_PATCH_APPLIED__) return;
  window.__VS_PATCH_APPLIED__ = true;

  // We reuse the globals declared earlier:
  // let ffmpeg; let ffmpegReady; progBar, progText, etc.

  // --- Override: ensureFFmpeg (version-locked, robust errors)
  ensureFFmpeg = async function ensureFFmpegPatched() {
    if (ffmpegReady) return;

    // Wrapper must be added in index.html:
    // <script src="https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.7/dist/ffmpeg.min.js"></script>
    if (!window.FFmpeg) {
      throw new Error('FFmpeg wrapper not found on window. Check the <script> in index.html.');
    }

    const { createFFmpeg, fetchFile } = window.FFmpeg;

    ffmpeg = createFFmpeg({
      log: false,
      // Keep core version in sync with the wrapper above.
      corePath: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.7/dist/ffmpeg-core.js'
    });

    try {
      await ffmpeg.load();
    } catch (e) {
      console.error('FFmpeg load error:', e);
      throw new Error('Failed to load FFmpeg core (network/ad-blocker?).');
    }

    // expose helper for use in compressVideo
    ensureFFmpeg.fetchFile = fetchFile;
    ffmpegReady = true;
  };

  // --- Override: compressVideo (uses Uint8Array directly, better errors)
  compressVideo = async function compressVideoPatched(file, preset) {
    await ensureFFmpeg();
    const { fetchFile } = ensureFFmpeg;

    const inName  = 'input.' + (file.name.split('.').pop() || 'mp4');
    const outName = 'output.mp4';

    try {
      ffmpeg.FS('writeFile', inName, await fetchFile(file));
    } catch (e) {
      console.error('FFmpeg writeFile error:', e);
      throw new Error('Could not write input to FFmpeg FS.');
    }

    const args = ['-i', inName, ...presetToFFmpegArgs(preset), outName];

    // Progress (FFmpeg → your bar)
    ffmpeg.setProgress(({ ratio }) => {
      const pct = Math.min(99, Math.floor((ratio || 0) * 100));
      progBar.style.width = pct + '%';
      progText.textContent = `Compressing… ${pct}%`;
    });

    try {
      await ffmpeg.run(...args);
    } catch (e) {
      console.error('FFmpeg run error:', e);
      throw new Error('FFmpeg failed while encoding.');
    }

    let data;
    try {
      data = ffmpeg.FS('readFile', outName);   // Uint8Array
    } catch (e) {
      console.error('FFmpeg readFile error:', e);
      throw new Error('Could not read output from FFmpeg FS.');
    } finally {
      try { ffmpeg.FS('unlink', inName); } catch {}
      try { ffmpeg.FS('unlink', outName); } catch {}
    }

    // IMPORTANT: construct Blob from the Uint8Array, not data.buffer (fixes iOS saves).
    return new Blob([data], { type: 'video/mp4' });
  };

  console.log('✅ VidShrink FFmpeg patch applied');
})();