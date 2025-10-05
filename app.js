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
let videoFile = null;
let estBytes  = null;
let currentMode = 'video'; // default

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

// Render result actions (Download + Save to Photos when available)
function renderResult(outBlob, filename, mime) {
  const url = URL.createObjectURL(outBlob);
  const canShareFiles = !!(navigator.canShare && navigator.canShare({
    files: [new File([outBlob], filename, { type: mime })]
  }));

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

  // Wire buttons
  const dl = document.getElementById('downloadLink');
  dl.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 3000));

  const sb = document.getElementById('shareBtn');
  if (sb) {
    sb.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [new File([outBlob], filename, { type: mime })] });
      } catch { /* user cancelled */ }
    });
  }
}

// === File picking & DnD ===
pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
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

// === Mode Switching ===
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

// === Preset change ===
presetSel.addEventListener('change', updateEstimate);

// === “Compression” simulator ===
startBtn.addEventListener('click', () => {
  if (!videoFile) return;

  // reset any previous result
  result.classList.add('hidden');
  result.innerHTML = '';

  progWrap.classList.remove('hidden');
  let width = 0;

  const timer = setInterval(async () => {
    width += 5;
    progBar.style.width = width + '%';
    progText.textContent = `Compressing… ${width}%`;

    if (width >= 100) {
      clearInterval(timer);
      progText.textContent = 'Done!';

      // === Final Output and Share Sheet Logic (single copy!) ===
      const outBytes = estBytes ?? videoFile.size;
      const savedBytes = Math.max(0, videoFile.size - outBytes);
      const savedPct = videoFile.size > 0
        ? Math.round((savedBytes / videoFile.size) * 100)
        : 0;

      saveRow?.classList.remove('hidden');
      saveEl.textContent =
        `${savedPct}% saved (${formatBytes(videoFile.size)} → ${formatBytes(outBytes)})`;

      // Simulated compressed Blob (swap in real encoder output later)
      const mime = (currentMode === 'photo') ? 'image/jpeg' : 'video/mp4';
      const outBlob = new Blob([new Uint8Array(Math.max(outBytes, 1024))], { type: mime });
      const outName = makeOutName(videoFile.name, currentMode);

      // Show result UI
      renderResult(outBlob, outName, mime);

      // Auto-open Share Sheet (fallback to download)
      try {
        const fileForShare = new File([outBlob], outName, { type: mime });
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [fileForShare] })) {
          await navigator.share({
            files: [fileForShare],
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

      // Fill the summary line under “Compression complete.”
      const pcts = result.querySelector('p.mono');
      if (pcts) pcts.textContent =
        `${savedPct}% saved (${formatBytes(videoFile.size)} → ${formatBytes(outBytes)})`;
    }
  }, 200);
});

resetBtn.addEventListener('click', () => location.reload());