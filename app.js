const fileInput = document.getElementById('file');
const pickBtn = document.getElementById('pick');
const drop = document.getElementById('drop');
const options = document.getElementById('options');
const startBtn = document.getElementById('start');
const resetBtn = document.getElementById('reset');
const progBar = document.getElementById('progBar');
const progWrap = document.getElementById('progWrap');
const progText = document.getElementById('progText');
const result = document.getElementById('result');
const year = document.getElementById('year');
year.textContent = new Date().getFullYear();

let videoFile;

pickBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

drop.addEventListener('dragover', e => {
  e.preventDefault();
  drop.style.background = '#eef6ff';
});
drop.addEventListener('dragleave', e => {
  drop.style.background = 'transparent';
});
drop.addEventListener('drop', e => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  videoFile = file;
  options.classList.remove('hidden');
  document.querySelector('.drop-inner').innerHTML = `<p><strong>${file.name}</strong> (${(file.size/1024/1024).toFixed(1)} MB)</p>`;
}

// Placeholder logic (you’ll later plug in ffmpeg.wasm)
startBtn.addEventListener('click', () => {
  progWrap.classList.remove('hidden');
  let width = 0;
  const simulate = setInterval(() => {
    width += 5;
    progBar.style.width = width + '%';
    progText.textContent = `Compressing… ${width}%`;
    if (width >= 100) {
      clearInterval(simulate);
      progText.textContent = 'Done!';
      result.classList.remove('hidden');
      result.innerHTML = `<p>✅ Compression complete. (Simulated)</p>`;
    }
  }, 200);
});

resetBtn.addEventListener('click', () => location.reload());
