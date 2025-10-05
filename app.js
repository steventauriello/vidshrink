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
  const ratios = {
    balanced:   0.40,
    losslessish:0.70,
    smaller:    0.25
  };
  const r = ratios[preset] ?? ratios.balanced;
  return Math.max(0.9 * MB, Math.round(inputBytes * r));
}

function updateEstimate() {
  if (!videoFile) return;
  estBytes = estimateOutputBytes(videoFile.size, presetSel.value);
  estEl.textContent = '≈ ' + formatBytes(estBytes);
  saveRow?.classList.add('hidden');
  saveEl.textContent = '—';
}

// === File picking & DnD ===
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

  progWrap.classList.remove('hidden');
  let width = 0;
  const timer = setInterval(() => {
    width += 5;
    progBar.style.width = width + '%';
    progText.textContent = `Compressing… ${width}%`;
    if (width >= 100) {
      clearInterval(timer);
      progText.textContent = 'Done!';

      const outBytes = estBytes ?? videoFile.size;
      const savedBytes = Math.max(0, videoFile.size - outBytes);
      const savedPct = videoFile.size > 0
        ? Math.round((savedBytes / videoFile.size) * 100)
        : 0;

      saveRow?.classList.remove('hidden');
      saveEl.textContent =
        `${savedPct}% saved (${formatBytes(videoFile.size)} → ${formatBytes(outBytes)})`;

      result.classList.remove('hidden');
      result.innerHTML = `
        <p>✅ Compression complete.</p>
        <p class="mono">${savedPct}% saved (${formatBytes(videoFile.size)} → ${formatBytes(outBytes)})</p>
      `;
    }
  }, 200);
});

resetBtn.addEventListener('click', () => location.reload());