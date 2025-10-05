/* VidShrink – on-device compressor with Video | Photo modes
   This file is self-contained; no external libs required for the photo path.
   The video path will simulate compression unless you wire in ffmpeg.wasm.
*/

// =============== Element refs ===============
const els = {
  file:     document.getElementById('file'),
  pick:     document.getElementById('pick'),
  drop:     document.getElementById('drop'),
  options:  document.getElementById('options'),
  preset:   document.getElementById('preset'),
  est:      document.getElementById('est'),
  start:    document.getElementById('start'),
  reset:    document.getElementById('reset'),
  progWrap: document.getElementById('progWrap'),
  progBar:  document.getElementById('progBar'),
  progText: document.getElementById('progText'),
  result:   document.getElementById('result'),
  modeVideoBtn: document.getElementById('modeVideo'),
  modePhotoBtn: document.getElementById('modePhoto'),
};

let currentFile = null;
let currentMode = 'video'; // 'video' | 'photo'

// =============== Presets ===============
const VIDEO_PRESETS = {
  balanced:    { maxH: 1080, targetMbps: 3.5, floorFactor: 0.40 }, // good quality
  losslessish: { maxH: null, targetMbps: null, percent: 0.75 },     // same res, ~25% smaller
  smaller:     { maxH: 720,  targetMbps: 1.8, floorFactor: 0.30 }, // smaller file
};

const IMAGE_PRESETS = {
  balanced:    { maxW: 1920, format: 'image/jpeg', quality: 0.8 },
  losslessish: { maxW: null,  format: 'image/jpeg', quality: 0.95 },
  smaller:     { maxW: 1280, format: 'image/jpeg', quality: 0.7 },
};

// =============== Small helpers ===============
const fmtBytes = (bytes) => {
  if (bytes == null) return '—';
  const u = ['B','KB','MB','GB']; let i=0; let n=bytes;
  while (n >= 1024 && i < u.length-1) { n/=1024; i++; }
  const dp = (n < 10 && i) ? 1 : 0;
  return `${n.toFixed(dp)} ${u[i]}`;
};

const setProgress = (ratio, text) => {
  els.progWrap.classList.remove('hidden');
  els.progBar.style.width = `${Math.max(0, Math.min(1, ratio))*100|0}%`;
  if (text) els.progText.textContent = text;
};

const clearProgress = () => {
  els.progBar.style.width = '0%';
  els.progText.textContent = 'Preparing…';
  els.progWrap.classList.add('hidden');
};

const clearResult = () => {
  els.result.innerHTML = '';
  els.result.classList.add('hidden');
};

const showResultDownload = (outFile, labelPrefix = 'Download') => {
  const url = URL.createObjectURL(outFile);
  const a = document.createElement('a');
  a.href = url;
  a.download = outFile.name;
  a.textContent = `${labelPrefix} (${fmtBytes(outFile.size)})`;
  els.result.innerHTML = '';
  els.result.appendChild(a);
  els.result.classList.remove('hidden');
};

// =============== Mode toggle ===============
function setMode(mode) {
  currentMode = mode;
  const sel = 'selected';
  els.modeVideoBtn?.classList.toggle(sel, mode === 'video');
  els.modePhotoBtn?.classList.toggle(sel, mode === 'photo');
  els.file.setAttribute(
    'accept',
    mode === 'video'
      ? 'video/*'
      : 'image/jpeg,image/png,image/webp,image/*'
  );
  els.est.textContent = '—';
  clearProgress();
  clearResult();
}
els.modeVideoBtn?.addEventListener('click', () => setMode('video'));
els.modePhotoBtn?.addEventListener('click', () => setMode('photo'));
setMode('video'); // default

// =============== Pick / Drop ===============
els.pick?.addEventListener('click', () => els.file.click());

els.file?.addEventListener('change', () => {
  currentFile = els.file.files?.[0] || null;
  handleSelectedFile();
});

['dragenter','dragover'].forEach(ev =>
  els.drop?.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    els.drop.classList.add('dragover');
  })
);
['dragleave','drop'].forEach(ev =>
  els.drop?.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    els.drop.classList.remove('dragover');
  })
);
els.drop?.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) {
    els.file.files = e.dataTransfer.files; // populate input for consistency
    currentFile = f;
    handleSelectedFile();
  }
});

els.reset?.addEventListener('click', () => {
  els.file.value = '';
  currentFile = null;
  els.options.classList.add('hidden');
  els.est.textContent = '—';
  clearProgress();
  clearResult();
});

// =============== Estimates ===============
async function estimateVideoOutput(file, presetKey) {
  // Try to read duration via a video element
  const duration = await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(isFinite(v.duration) ? v.duration : null);
    };
    v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    v.src = url;
  });

  const preset = VIDEO_PRESETS[presetKey] || VIDEO_PRESETS.balanced;
  if (!duration) {
    // Fallback: simple percentage
    const pct =
      presetKey === 'smaller' ? 0.45 :
      presetKey === 'losslessish' ? 0.75 : 0.6;
    return Math.max(200_000, Math.round(file.size * pct));
  }

  // Estimate original bitrate
  const origMbps = (file.size * 8) / duration / 1e6; // Mbit/sec
  let targetMbps;

  if (preset.percent) {
    // lossless-ish: keep same bitrate but reduce ~25%
    targetMbps = origMbps * preset.percent;
  } else {
    targetMbps = Math.min(origMbps, preset.targetMbps);
    // enforce a floor (if original is already very small)
    const floor = origMbps * (preset.floorFactor ?? 0.4);
    targetMbps = Math.max(targetMbps, floor);
  }

  const outBytes = (targetMbps * 1e6 / 8) * duration;
  return Math.max(200_000, Math.round(outBytes));
}

function estimatePhotoOutput(file, presetKey) {
  // Heuristic: JPEG quality factor, plus a bonus if we also resize
  const p = IMAGE_PRESETS[presetKey] || IMAGE_PRESETS.balanced;
  let factor = p.quality ?? 0.8;
  if (p.maxW) factor *= 0.85; // downscale usually adds extra savings
  return Math.max(30_000, Math.round(file.size * factor));
}

async function updateEstimate() {
  if (!currentFile) { els.est.textContent = '—'; return; }
  const presetKey = els.preset?.value || 'balanced';
  let bytes;
  if (currentMode === 'video') {
    bytes = await estimateVideoOutput(currentFile, presetKey);
  } else {
    bytes = estimatePhotoOutput(currentFile, presetKey);
  }
  els.est.textContent = `≈ ${fmtBytes(bytes)}`;
}

// =============== Photo compression (Canvas) ===============
async function compressImageFile(file, presetKey = 'balanced', onProgress = () => {}) {
  const opt = IMAGE_PRESETS[presetKey] || IMAGE_PRESETS.balanced;

  const srcUrl = URL.createObjectURL(file);
  // Prefer createImageBitmap for speed, fall back to <img>
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = srcUrl;
    });
  }

  let w = bmp.width, h = bmp.height;
  if (opt.maxW && w > opt.maxW) {
    const s = opt.maxW / w; w = Math.round(w * s); h = Math.round(h * s);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);

  onProgress(0.4, 'Optimizing…');
  const blob = await new Promise(res => canvas.toBlob(
    res,
    opt.format || 'image/jpeg',
    opt.quality ?? 0.8
  ));
  onProgress(1, 'Done');

  URL.revokeObjectURL(srcUrl);

  const ext = (blob.type.includes('webp')) ? 'webp' : 'jpg';
  const name = file.name.replace(/\.[^.]+$/, '') + `-small.${ext}`;
  return new File([blob], name, { type: blob.type });
}

// =============== Video compression (placeholder) ===============
// If you later wire ffmpeg.wasm, replace this with your real pipeline.
async function compressVideoSimulated(file, presetKey = 'balanced', onProgress = () => {}) {
  onProgress(0.15, 'Analyzing…');
  const estBytes = await estimateVideoOutput(file, presetKey);
  // “Simulate” work:
  await new Promise(r => setTimeout(r, 350));
  onProgress(0.55, 'Transcoding…');
  await new Promise(r => setTimeout(r, 600));
  onProgress(0.85, 'Finalizing…');
  await new Promise(r => setTimeout(r, 350));

  // Create a small placeholder blob to represent output (for download UX).
  // If you prefer to return the original contents, you can; the estimate remains helpful.
  const dummy = new Uint8Array(Math.min(estBytes, 512 * 1024)); // cap placeholder to 512KB
  const outName = file.name.replace(/\.[^.]+$/, '') + '-small.mp4';
  return new File([dummy], outName, { type: 'video/mp4' });
}

// =============== Main actions ===============
async function handleSelectedFile() {
  clearProgress();
  clearResult();
  if (!currentFile) {
    els.options.classList.add('hidden');
    els.est.textContent = '—';
    return;
  }
  els.options.classList.remove('hidden');
  await updateEstimate();
}

els.preset?.addEventListener('change', updateEstimate);

els.start?.addEventListener('click', async () => {
  if (!currentFile) return;
  const presetKey = els.preset?.value || 'balanced';

  try {
    if (currentMode === 'photo') {
      setProgress(0.1, 'Preparing image…');
      const outFile = await compressImageFile(currentFile, presetKey, setProgress);
      showResultDownload(outFile, 'Download photo');
      setProgress(1, 'Done');
    } else {
      setProgress(0.1, 'Preparing video…');
      // Replace this line when ffmpeg is wired:
      const outFile = await compressVideoSimulated(currentFile, presetKey, setProgress);
      showResultDownload(outFile, 'Download video');
      setProgress(1, 'Done');
    }
  } catch (err) {
    console.error(err);
    els.progText.textContent = 'Something went wrong.';
  }
});