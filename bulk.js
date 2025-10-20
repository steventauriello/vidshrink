"use strict";

/* DOM */
const fileInput = document.getElementById('file');
const pickBtn   = document.getElementById('pick');
const dropZone  = document.getElementById('drop');
const options   = document.getElementById('options');
const presetSel = document.getElementById('preset');
const startBtn  = document.getElementById('start');
const progWrap  = document.getElementById('progWrap');
const progBar   = document.getElementById('progBar');
const progText  = document.getElementById('progText');
const resultEl  = document.getElementById('result');
const zipBtn    = document.getElementById('zipBtn');
const shareBtn  = document.getElementById('shareBtn');
document.getElementById('year').textContent = new Date().getFullYear();

/* State */
let pickedFiles = [];
let compressedFiles = []; // {name, blob}

// Merge + de-duplicate by name+size so repeat drops don't double-count
function dedupe(list) {
  const map = new Map();
  for (const f of list) {
    const key = `${f.name}::${f.size}`;
    if (!map.has(key)) map.set(key, f);
  }
  return [...map.values()];
}
function renderFileList() {
  const inner = dropZone.querySelector('.drop-inner');

  if (!pickedFiles.length) {
    inner.innerHTML = `
      <p><strong>Drag & drop</strong> your photos here, or</p>
      <button id="pick" class="btn primary">Choose Files</button>
    `;
    // Re-wire the Choose button (because we just replaced innerHTML)
    inner.querySelector('#pick')?.addEventListener('click', () => fileInput.click());
    return;
  }

  const list = pickedFiles
    .map(f => `<li title="${f.name}">${f.name}</li>`)
    .join('');

  inner.innerHTML = `
    <p><strong>${pickedFiles.length}</strong> photo${pickedFiles.length > 1 ? 's' : ''} selected:</p>
    <ul class="file-list">${list}</ul>
    <div class="file-actions" style="margin-top:.5rem">
      <button id="clearAll" class="btn secondary">Clear all</button>
    </div>
  `;

  // Clear-all handler
  inner.querySelector('#clearAll')?.addEventListener('click', () => {
    pickedFiles = [];
    const dt = new DataTransfer();
    fileInput.files = dt.files;        // empty the native input too
    options.classList.add('hidden');
    renderFileList();
  });
}



const MB = 1024*1024;
const fmt = b => b < MB ? `${Math.max(1,Math.round(b/1024))} KB` : `${(b/MB).toFixed(1)} MB`;
const scrollToEl = el => el?.scrollIntoView({ behavior:'smooth', block:'start' });

/* Image compression (canvas-based; good quality & tiny) */
async function compressImage(file, preset){
  const q = preset==='same' ? 0.75 : preset==='smallest' ? 0.25 : 0.55;

  // load
  const url = URL.createObjectURL(file);
  const img = new Image(); img.decoding="async"; img.src=url; await img.decode(); URL.revokeObjectURL(url);

  // optional downscale based on preset
  let w = img.naturalWidth, h = img.naturalHeight;
  const maxW = preset==='small' ? 1280 : (preset==='smallest' ? 720 : null);
  if (maxW && w > maxW){ const s = maxW / w; w = Math.round(maxW); h = Math.round(h * s); }

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', {alpha:false});
  ctx.drawImage(img, 0, 0, w, h);

  return await new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
}

// Choose button (unchanged)
pickBtn.addEventListener('click', () => fileInput.click());

// File picker selection — APPEND instead of replace
fileInput.addEventListener('change', e => {
  const files = [...(e.target.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;

  pickedFiles = dedupe([...pickedFiles, ...files]);

  // keep the native input in sync so later code paths stay consistent
  const dt = new DataTransfer();
  pickedFiles.forEach(f => dt.items.add(f));
  fileInput.files = dt.files;

  options.classList.remove('hidden');
renderFileList();

  // allow re-selecting the same files again later
  fileInput.value = '';
  setTimeout(() => scrollToEl(startBtn), 150);
});

// Drag & drop — APPEND instead of replace
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');

  const files = [...(e.dataTransfer.files || [])].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;

  pickedFiles = dedupe([...pickedFiles, ...files]);

  // sync the input
  const dt = new DataTransfer();
  pickedFiles.forEach(f => dt.items.add(f));
  fileInput.files = dt.files;

  options.classList.remove('hidden');
  dropZone.querySelector('.drop-inner').innerHTML =
    `<p><strong>${pickedFiles.length}</strong> photos selected</p>`;

  setTimeout(() => scrollToEl(startBtn), 150);
});
/* Start */
startBtn.addEventListener('click', async ()=>{
  if(!pickedFiles.length) return;

  compressedFiles = [];
  resultEl.classList.add('hidden'); resultEl.innerHTML = '';
  document.getElementById('shareButtons').classList.add('hidden');

  progWrap.classList.remove('hidden'); progBar.style.width='0%'; progText.textContent='Preparing…';
  scrollToEl(progWrap);
  startBtn.disabled = true;

  const preset = presetSel.value || 'small';

  try{
    for(let i=0;i<pickedFiles.length;i++){
      const f = pickedFiles[i];
      progText.textContent = `Compressing ${i+1} of ${pickedFiles.length}: ${f.name}`;
      const out = await compressImage(f, preset);
      const name = f.name.replace(/\.[^.]+$/, '') + '-vs.jpg';
      compressedFiles.push({ name, blob: out });
      progBar.style.width = `${Math.round(((i+1)/pickedFiles.length)*100)}%`;
    }
    progText.textContent = 'Compression complete';

    // List results
    resultEl.innerHTML = compressedFiles.map(({name, blob})=>{
      return `<div class="thumb-row"><span>${name}</span><span>${fmt(blob.size)}</span></div>`;
    }).join('');
    resultEl.classList.remove('hidden');

    // Show actions
    document.getElementById('shareButtons').classList.remove('hidden');

    // Success tagline
    const note = document.createElement('p');
    note.className = 'mono';
    note.style.marginTop = '.5rem';
    note.innerHTML = `OneZip ready — <strong>${compressedFiles.length}</strong> photos bundled and optimized for sharing.`;
    resultEl.appendChild(note);

    setTimeout(()=>scrollToEl(resultEl), 200);
  }catch(err){
    console.error(err);
    progText.textContent = err?.message || 'Error while compressing.';
  }finally{
    startBtn.disabled = false;
    fileInput.value = '';
  }
});

/* ZIP download */
zipBtn.addEventListener('click', async ()=>{
  if(!compressedFiles.length) return;
  const zip = new JSZip();
  for(const f of compressedFiles) zip.file(f.name, f.blob);
  const blob = await zip.generateAsync({ type:'blob' });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='VidShrink-OneZip.zip'; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
});

/* Share individually (mobile) */
shareBtn.addEventListener('click', async ()=>{
  if(!compressedFiles.length) return;
  const files = compressedFiles.map(({name, blob}) => new File([blob], name, { type: 'image/jpeg' }));
  if(navigator.share && navigator.canShare?.({ files })){
    try{ await navigator.share({ title:'VidShrink photos', text:'Compressed with VidShrink', files }); }
    catch(e){ console.log('Share canceled/failed', e); }
  } else {
    alert('Sharing files is not supported on this browser. Please use Download ZIP instead.');
  }
});
