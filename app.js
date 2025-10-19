// =======================================
// VidShrink — main client script (UMD, wired)
// =======================================

"use strict";

// Wait until the FFmpeg UMD wrapper is available.
// More tolerant (longer timeout + better diagnostics).
async function waitForFFmpegGlobal(timeout = 15000) {
  const ready = () =>
    !!(window.FFmpeg && typeof window.FFmpeg.createFFmpeg === "function");

  if (ready()) {
    console.log("✅ FFmpeg UMD wrapper present (no wait).");
    return;
  }

  const t0 = performance.now();
  while (!ready()) {
    if (performance.now() - t0 > timeout) {
      console.error("FFmpeg UMD still missing after wait.", {
        FFmpeg: window.FFmpeg,
        FFmpegUtil: window.FFmpegUtil
      });
      throw new Error(
        "FFmpeg UMD script not ready. Check index.html load order (no 'defer' on UMD) or try self-hosting the UMD files."
      );
    }
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`✅ FFmpeg UMD wrapper detected after ${Math.round(performance.now() - t0)} ms.`);
}

/* ---------- UMD globals (no URL changes) ---------- */
// Resolve the FFmpeg factory lazily; don't throw at startup.
let __createFFmpeg = null;

// fetchFile usually comes from @ffmpeg/util UMD
let fetchFileGlobal =
  (window.FFmpegUtil && window.FFmpegUtil.fetchFile) ||
  (window.FFmpeg && window.FFmpeg.fetchFile) ||
  window.fetchFile || // some bundles leak it flat
  null;

function getCreateFFmpeg() {
  if (typeof __createFFmpeg === "function") return __createFFmpeg;

  // Try common UMD attachment points
  const spots = [
    () => window.FFmpeg && window.FFmpeg.createFFmpeg,
    () => window.FFmpegWASM && window.FFmpegWASM.createFFmpeg,
    () => window.FFmpegWASM && window.FFmpegWASM.default && window.FFmpegWASM.default.createFFmpeg, // default export
    () => globalThis.FFmpeg && globalThis.FFmpeg.createFFmpeg,
    () => globalThis.ffmpeg && globalThis.ffmpeg.createFFmpeg,
    () => window.createFFmpeg, // sometimes exported flat
  ];

  for (const pick of spots) {
    const f = pick();
    if (typeof f === "function") { __createFFmpeg = f; return f; }
  }

  // Last resort: scan window for any object that exposes createFFmpeg (or default.createFFmpeg)
  try {
    for (const key of Object.keys(window)) {
      const v = window[key];
      if (v && typeof v === "object") {
        if (typeof v.createFFmpeg === "function") { __createFFmpeg = v.createFFmpeg; return __createFFmpeg; }
        if (v.default && typeof v.default.createFFmpeg === "function") { __createFFmpeg = v.default.createFFmpeg; return __createFFmpeg; }
      }
    }
  } catch { /* ignore cross-origin props */ }

  return null; // ensureFFmpeg() will throw at click-time if still null
}


/* Path unchanged */
window.__FFMPEG_CORE_PATH = "/assets/ffmpeg/ffmpeg-core.js";

/* ---------- DOM refs ---------- */
const fileInput  = document.getElementById("file");
const pickBtn    = document.getElementById("pick");
const drop       = document.getElementById("drop");
const options    = document.getElementById("options");
const startBtn   = document.getElementById("start");
const resetBtn   = document.getElementById("reset");
const progBar    = document.getElementById("progBar");
const progWrap   = document.getElementById("progWrap");
const progText   = document.getElementById("progText");
const result     = document.getElementById("result");
const presetSel  = document.getElementById("preset");

const origEl     = document.getElementById("orig");
const estEl      = document.getElementById("est");
const saveRow    = document.getElementById("savingsRow");
const saveEl     = document.getElementById("save");

const modeVideo  = document.getElementById("modeVideo");
const modePhoto  = document.getElementById("modePhoto");
const yearEl     = document.getElementById("year");
if (yearEl) yearEl.textContent = new Date().getFullYear();
saveRow?.classList.add("hidden");
if (resetBtn) resetBtn.disabled = true;

/* ---------- Class shims to match your CSS (no behavior change) ---------- */
(function applyClassShims(){
  const modeWrap = document.querySelector('.mode-toggle');
  modeWrap && modeWrap.classList.add('mode');      // your CSS styles .mode .chip
  modeVideo && modeVideo.classList.add('chip');
  modePhoto && modePhoto.classList.add('chip');

  drop && drop.classList.add('drop');              // map .dropzone → .drop style
  options && options.classList.add('options');     // options card styles

  options?.querySelectorAll('.preset-row').forEach(r => r.classList.add('row'));

  // progress bar CSS expects .progress .bar
  progBar && progBar.classList.add('bar');
})();

/* ---------- iOS-safe picker ---------- */
pickBtn?.addEventListener("click", () => {
  if (!fileInput) return;
  fileInput.value = "";
  try { if (typeof fileInput.showPicker === "function") { fileInput.showPicker(); return; } } catch {}
  fileInput.click();
});

/* ---------- Mode toggle (restored) ---------- */
let currentMode = "video";
function setActive(btn, on){
  if (!btn) return;
  btn.classList.toggle("selected", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}
// === Mode toggle handling ===
function setMode(mode) {
  currentMode = mode;
  const isVideo = mode === "video";
  setActive(modeVideo, isVideo);
  setActive(modePhoto, !isVideo);

  if (fileInput) fileInput.accept = isVideo ? "video/*" : "image/*";
  if (pickBtn)   pickBtn.textContent  = isVideo ? "Choose Video"   : "Choose Photo";
  if (startBtn)  startBtn.textContent = isVideo ? "Compress Video" : "Compress Photo";
  document.body.dataset.mode = mode;
}

// --- Disable video mode temporarily ---
const VIDEO_DISABLED = true;

function showComingSoon() {
  const msg = `
    <p class="mono">🎬 Video compression is <strong>coming soon</strong>.</p>
    <p class="mono" style="opacity:.85">Photo compression works now — try it below!</p>
  `;
  const result = document.getElementById("result");
  if (result) {
    result.classList.remove("hidden");
    result.innerHTML = msg;
  }
}

// --- Mode buttons ---
modeVideo?.addEventListener("click", (e) => {
  e.preventDefault();
  if (VIDEO_DISABLED) {
    showComingSoon();
    return;
  }
  setMode("video");
});

modePhoto?.addEventListener("click", (e) => {
  e.preventDefault();
  setMode("photo");
});

// --- Default to photo mode ---
setMode("photo");

/* ---------- State ---------- */
let pickedFile = null;
let estBytes   = null;

/* ---------- Helpers ---------- */
const MB = 1024 * 1024;
function formatBytes(bytes){
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < MB) return `${Math.max(1, Math.round(bytes/1024))} KB`;
  const v = bytes / MB;
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " MB";
}
function estimateOutputBytes(inputBytes, preset){
  const ratios = { same: 0.75, small: 0.55, smallest: 0.25 };
  const r = ratios[preset] ?? ratios.small;
  return Math.max(0.9*MB, Math.round(inputBytes * r));
}
function updateEstimate(){
  if (!pickedFile) return;
  estBytes = estimateOutputBytes(pickedFile.size, presetSel?.value);
  if (estEl) estEl.textContent = "≈ " + formatBytes(estBytes);
  saveRow?.classList.add("hidden");
  if (saveEl) saveEl.textContent = "—";
}
presetSel?.addEventListener("change", updateEstimate);

function makeOutName(name, mode="video"){
  const i = name.lastIndexOf(".");
  const stem = i > -1 ? name.slice(0, i) : name;
  return `${stem}-shrink${mode === "photo" ? ".jpg" : ".mp4"}`;
}

/* ---------- Result UI ---------- */
function renderResult(outBlob, filename, mime){
  const url = URL.createObjectURL(outBlob);
  const canShareFiles = !!(navigator.share && navigator.canShare && navigator.canShare({
    files: [new File([outBlob], filename, { type: mime })]
  }));
  const shareBtnHTML = canShareFiles
    ? `<button id="shareBtn" class="btn primary" type="button" style="margin-right:.5rem">Save to Photos</button>`
    : "";

  result?.classList.remove("hidden");
  if (result){
    result.innerHTML = `
      <p>✅ Compression complete.</p>
      <p class="mono" style="margin-bottom:.5rem"></p>
      <div style="display:flex; flex-wrap:wrap; gap:.5rem; align-items:center">
        ${shareBtnHTML}
        <a id="downloadLink" class="btn" href="${url}" download="${filename}">Download</a>
        <span class="mono" style="margin-left:.25rem; opacity:.85">${filename}</span>
      </div>
      <p class="mono" style="margin-top:.5rem">Tip: On iPhone/Android, “Save to Photos” opens the Share sheet.</p>
    `;
  }
  document.getElementById("downloadLink")?.addEventListener("click", () =>
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  );
  document.getElementById("shareBtn")?.addEventListener("click", async () => {
    try { await navigator.share({ files: [new File([outBlob], filename, { type: mime })] }); } catch {}
  });
}

// ---------- FFmpeg Factory Resolver ----------
function getCreateFFmpeg() {
  if (typeof __createFFmpeg === "function") return __createFFmpeg;

  const candidate =
    window.FFmpeg?.createFFmpeg ||
    window.FFmpegWASM?.createFFmpeg ||
    window.FFmpegWASM?.default?.createFFmpeg ||
    window.createFFmpeg ||
    globalThis.FFmpeg?.createFFmpeg ||
    globalThis.ffmpeg?.createFFmpeg ||
    null;

  if (typeof candidate === "function") {
    __createFFmpeg = candidate;
    return __createFFmpeg;
  }

  // Last-resort deep scan
  try {
    for (const key of Object.keys(window)) {
      const v = window[key];
      if (v && typeof v === "object") {
        if (typeof v.createFFmpeg === "function") {
          __createFFmpeg = v.createFFmpeg;
          return __createFFmpeg;
        }
        if (v.default && typeof v.default.createFFmpeg === "function") {
          __createFFmpeg = v.default.createFFmpeg;
          return __createFFmpeg;
        }
      }
    }
  } catch {}

  return null;
}


/* ---------- FFmpeg loader (video) ---------- */

let ffmpeg, ffmpegReady = false;
async function ensureFFmpeg(){
    await waitForFFmpegGlobal();

if (ffmpegReady) return;

  const corePath = window.__FFMPEG_CORE_PATH || "/assets/ffmpeg/ffmpeg-core.js";

  // quick probe helps catch bad path/CORS early
  try {
    const head = await fetch(corePath, { method: "HEAD" });
    if (!head.ok) throw new Error(`HTTP ${head.status}`);
  } catch {
    throw new Error(`Can't fetch ffmpeg-core.js at ${corePath}`);
  }

  // Choose whichever UMD global actually exposed createFFmpeg
const factory = getCreateFFmpeg();

if (typeof factory !== "function") {
  console.error("No createFFmpeg() on expected globals:", {
    FFmpeg: window.FFmpeg,
    FFmpegWASM: window.FFmpegWASM,
    createFFmpegFlat: window.createFFmpeg
  });
  throw new Error("FFmpeg wrapper not found — ensure the UMD scripts loaded.");
}

ffmpeg = factory({ log: true, corePath });


  ffmpeg.setLogger?.(({ type, message }) => console.log(`[ffmpeg:${type}]`, message));

  await ffmpeg.load();

  // attach a working fetchFile (UMD util)
  if (!ensureFFmpeg.fetchFile) {
  if (!fetchFileGlobal) {
    fetchFileGlobal =
      (window.FFmpegUtil && window.FFmpegUtil.fetchFile) ||
      (window.FFmpeg && window.FFmpeg.fetchFile) ||
      window.fetchFile || null;
  }
  if (!fetchFileGlobal)
    throw new Error("fetchFile not found — ensure @ffmpeg/util UMD is loaded.");
  ensureFFmpeg.fetchFile = fetchFileGlobal;
}
ffmpegReady = true;
}


/* ---------- Video compression ---------- */
function presetToFFmpegArgs(preset){
  let crf = 23, maxW = null;
  if (preset === "same") { crf = 23; }
  else if (preset === "small"){ crf = 28; maxW = 1080; }
  else if (preset === "smallest"){ crf = 30; maxW = 720; }
  const vf = maxW ? ["-vf", `scale=min(${maxW},iw):-2`] : [];
  return [
    "-pix_fmt","yuv420p",
    "-c:v","libx264",
    "-crf", String(crf),
    "-preset","veryfast",
    ...vf,
    "-movflags","+faststart",
    "-c:a","aac","-b:a","128k"
  ];
}
async function compressVideo(file, preset){
  await ensureFFmpeg();
  const inName  = "input." + ((file.name.split(".").pop() || "mp4").toLowerCase());
  const outName = "output.mp4";

  ffmpeg.FS("writeFile", inName, await ensureFFmpeg.fetchFile(file));
  ffmpeg.setProgress?.(({ ratio }) => {
    const pct = Math.min(99, Math.floor((ratio || 0) * 100));
    if (progBar)  progBar.style.width = pct + "%";
    if (progText) progText.textContent = `Compressing… ${pct}%`;
  });

  await ffmpeg.run("-i", inName, ...presetToFFmpegArgs(preset), outName);

  const data = ffmpeg.FS("readFile", outName);
  const blob = new Blob([data], { type: "video/mp4" });
  try { ffmpeg.FS("unlink", inName); } catch {}
  try { ffmpeg.FS("unlink", outName); } catch {}

  if (!blob.size) throw new Error("Encoding produced an empty file.");
  return blob;
}

/* ---------- Image compression ---------- */
async function compressImage(file, preset){
  const isHEIC = /image\/hei(c|f)/i.test(file.type);
  const cfgMap = {
    same:     { maxW: null,  target: 0.80, qStart: isHEIC ? 0.70 : 0.85, qMin: 0.60 },
    small:    { maxW: 1280,  target: 0.55, qStart: isHEIC ? 0.60 : 0.78, qMin: 0.50 },
    smallest: { maxW:  720,  target: 0.30, qStart: isHEIC ? 0.50 : 0.66, qMin: 0.40 },
  };
  const cfg = cfgMap[preset] || cfgMap.small;
  const target = Math.min(Math.round(file.size * cfg.target), file.size - 20*1024);

  const url = URL.createObjectURL(file);
  const img = new Image(); img.decoding = "async"; img.src = url; await img.decode(); URL.revokeObjectURL(url);

  let w = img.naturalWidth, h = img.naturalHeight;
  if (cfg.maxW && w > cfg.maxW){ const s = cfg.maxW / w; w = Math.round(cfg.maxW); h = Math.round(h * s); }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha:false });
  const draw = ()=>{ canvas.width = w; canvas.height = h; ctx.drawImage(img, 0, 0, w, h); };
  draw();

  const encode = q => new Promise(res => canvas.toBlob(res, "image/jpeg", q));

  let q = cfg.qStart, out = await encode(q);
  while (out && out.size > target && q > cfg.qMin){ q = Math.max(cfg.qMin, q - 0.05); out = await encode(q); }
  if (out && out.size >= file.size){
    if (!cfg.maxW || img.naturalWidth <= cfg.maxW){ w = Math.round(w*0.9); h = Math.round(h*0.9); draw(); }
    q = Math.max(cfg.qMin, q - 0.10); out = await encode(q);
  }
  return (!out || out.size >= file.size) ? file : out;
}

/* ---------- File pick & DnD ---------- */
fileInput?.addEventListener("change", (e) => handleFile(e.target.files[0]));
drop?.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
drop?.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop?.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("dragover"); handleFile(e.dataTransfer.files[0]); });

function handleFile(file){
  if (!file) return;
  pickedFile = file;

  const inner = document.querySelector(".drop-inner");
  inner && (inner.innerHTML = `<p><strong>${file.name}</strong> (${formatBytes(file.size)})</p>`);

  options?.classList.remove("hidden");
  origEl && (origEl.textContent = formatBytes(file.size));
  updateEstimate();

  result && (result.classList.add("hidden"), result.innerHTML = "");
  progWrap?.classList.add("hidden");
  progBar && (progBar.style.width = "0%");
  progText && (progText.textContent = "Preparing…");
}

/* ---------- Start + Reset ---------- */
startBtn?.addEventListener("click", async () => {
  if (!pickedFile) return;

  startBtn && (startBtn.disabled = true, startBtn.setAttribute("aria-busy","true"));
  resetBtn && (resetBtn.disabled = true);

  result && (result.classList.add("hidden"), result.innerHTML = "");
  progWrap?.classList.remove("hidden");
  progBar && (progBar.style.width = "0%");
  progText && (progText.textContent = "Preparing…");

  try {
    const preset = presetSel?.value || "small";
    let outBlob, mime;

    if (currentMode === "photo"){
      mime = "image/jpeg";
      // small visual shim
      for (let w = 0; w <= 25; w += 5){
        await new Promise(r => setTimeout(r, 25));
        progBar && (progBar.style.width = `${w}%`);
        progText && (progText.textContent = `Compressing… ${w}%`);
      }
      outBlob = await compressImage(pickedFile, preset);
    } else {
      mime = "video/mp4";
      outBlob = await compressVideo(pickedFile, preset);
    }

    progBar && (progBar.style.width = "100%");
    progText && (progText.textContent = "Done!");

    const outBytes   = outBlob.size ?? estBytes ?? pickedFile.size;
    const savedBytes = Math.max(0, pickedFile.size - outBytes);
    const savedPct   = pickedFile.size > 0 ? Math.round((savedBytes / pickedFile.size) * 100) : 0;

    renderResult(outBlob, makeOutName(pickedFile.name, currentMode), mime);

    const pcts = result?.querySelector("p.mono");
    pcts && (pcts.textContent = `${savedPct}% saved (${formatBytes(pickedFile.size)} → ${formatBytes(outBytes)})`);

    resetBtn && (resetBtn.disabled = false);
  } catch (err){
    console.error(err);
    progText && (progText.textContent = err?.message || "Something went wrong.");
  } finally {
    startBtn && (startBtn.disabled = false, startBtn.removeAttribute("aria-busy"));
  }
});
resetBtn?.addEventListener("click", () => location.reload());
