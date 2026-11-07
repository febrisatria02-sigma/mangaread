/* ============================================================
   Manga Reader — core: storage, import, library
   Vanilla JS, no build step. Data lives in IndexedDB.
   ============================================================ */

'use strict';

/* ---------------- tiny helpers ---------------- */

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* Natural sort: 1, 2, 10 (not 1, 10, 2) */
const naturalCompare = (a, b) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------------- IndexedDB ---------------- */

const DB_NAME = 'manga-reader';
const DB_VERSION = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      // series: one row per comic title
      if (!d.objectStoreNames.contains('series')) {
        d.createObjectStore('series', { keyPath: 'id' });
      }
      // chapters: pages are Blobs, grouped under a series
      if (!d.objectStoreNames.contains('chapters')) {
        const s = d.createObjectStore('chapters', { keyPath: 'id' });
        s.createIndex('seriesId', 'seriesId');
      }
      // settings: single key-value bag
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return db.transaction(store, mode).objectStore(store);
}

const dbGetAll = (store) => new Promise((res, rej) => {
  const r = tx(store).getAll();
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const dbGet = (store, key) => new Promise((res, rej) => {
  const r = tx(store).get(key);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const dbPut = (store, val) => new Promise((res, rej) => {
  const r = tx(store, 'readwrite').put(val);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const dbDel = (store, key) => new Promise((res, rej) => {
  const r = tx(store, 'readwrite').delete(key);
  r.onsuccess = () => res();
  r.onerror = () => rej(r.error);
});

/* ---------------- settings ---------------- */

const DEFAULTS = {
  mode: 'webtoon',
  direction: 'ltr',
  fit: 'width',
  webtoonWidth: 100,
};

let settings = { ...DEFAULTS };

async function loadSettings() {
  const rows = await dbGetAll('settings');
  rows.forEach((r) => { settings[r.key] = r.value; });
}

async function saveSetting(key, value) {
  settings[key] = value;
  await dbPut('settings', { key, value });
}

/* ---------------- import: archive or images ---------------- */

/* Convert a Blob/File to an ImageBitmap-friendly Blob and keep natural order. */
async function extractFromArchive(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = [];

  zip.forEach((path, entry) => {
    if (entry.dir) return;
    if (/\.(jpe?g|png|webp|gif|avif)$/i.test(path)) {
      if (path.startsWith('__MACOSX/') || path.includes('/._')) return; // macOS junk
      entries.push({ path, entry });
    }
  });

  entries.sort((a, b) => naturalCompare(a.path, b.path));

  const pages = [];
  for (const { entry } of entries) {
    const blob = await entry.async('blob');
    pages.push(blob);
  }
  return pages;
}

async function extractFromFiles(files) {
  const list = Array.from(files)
    .filter((f) => f.type.startsWith('image/'))
    .sort((a, b) => naturalCompare(a.name, b.name));
  return list; // Files are Blobs already
}

/* Build a cover thumbnail from the first page. */
async function makeCover(blob, maxW = 300) {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxW / bmp.width);
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  } catch {
    return null;
  }
}

/* Find or create a series by title. */
async function upsertSeries(title) {
  const all = await dbGetAll('series');
  const found = all.find((s) => s.title.toLowerCase() === title.toLowerCase());
  if (found) return found;
  const s = {
    id: uid(),
    title,
    cover: null,
    createdAt: Date.now(),
    lastReadAt: 0,
    lastChapterId: null,
    lastPage: 0,
  };
  await dbPut('series', s);
  return s;
}

async function importChapter({ title, chapterName, pages }) {
  if (!pages.length) throw new Error('Tidak ada gambar ditemukan');

  const series = await upsertSeries(title);
  const chapter = {
    id: uid(),
    seriesId: series.id,
    name: chapterName || 'Chapter',
    pages,                 // array of Blobs
    pageCount: pages.length,
    createdAt: Date.now(),
    lastPage: 0,
  };
  await dbPut('chapters', chapter);

  // cover from first page of the series (only if not set yet)
  if (!series.cover) {
    const cover = await makeCover(pages[0]);
    if (cover) {
      series.cover = cover;
      await dbPut('series', series);
    }
  }
  return { series, chapter };
}

/* ---------------- library rendering ---------------- */

let seriesCache = [];
let chapterCache = [];

async function refreshLibrary() {
  seriesCache = await dbGetAll('series');
  chapterCache = await dbGetAll('chapters');

  // attach chapter counts + progress
  const bySeries = new Map();
  chapterCache.forEach((c) => {
    if (!bySeries.has(c.seriesId)) bySeries.set(c.seriesId, []);
    bySeries.get(c.seriesId).push(c);
  });

  seriesCache.forEach((s) => {
    const chs = (bySeries.get(s.id) || []).sort((a, b) => naturalCompare(a.name, b.name));
    s._chapters = chs;
    s._chapterCount = chs.length;
    const idx = chs.findIndex((c) => c.id === s.lastChapterId);
    s._progress = idx >= 0 && chs[idx].pageCount
      ? Math.round(((chs[idx].lastPage || 0) / chs[idx].pageCount) * 100)
      : 0;
  });

  seriesCache.sort((a, b) => (b.lastReadAt || b.createdAt) - (a.lastReadAt || a.createdAt));
  renderGrid();
}

function renderGrid() {
  const grid = $('#library-grid');
  const empty = $('#empty-state');
  grid.innerHTML = '';

  if (!seriesCache.length) {
    empty.classList.add('show');
    return;
  }
  empty.classList.remove('show');

  seriesCache.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'card';

    const img = document.createElement('img');
    img.className = 'card-cover';
    img.loading = 'lazy';
    img.alt = s.title;
    if (s.cover) {
      img.src = URL.createObjectURL(s.cover);
      img.onload = () => URL.revokeObjectURL(img.src); // free memory
    }
    card.appendChild(img);

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-title"></div>
      <div class="card-sub">${s._chapterCount} chapter${s._progress ? ' · ' + s._progress + '%' : ''}</div>
      <div class="card-progress"><i style="width:${s._progress}%"></i></div>`;
    body.querySelector('.card-title').textContent = s.title;
    card.appendChild(body);

    const menu = document.createElement('button');
    menu.className = 'card-menu';
    menu.textContent = '⋮';
    menu.onclick = (e) => { e.stopPropagation(); openSeriesMenu(s); };
    card.appendChild(menu);

    card.onclick = () => openSeries(s);
    grid.appendChild(card);
  });
}

/* ---------------- series actions ---------------- */

function openSeriesMenu(s) {
  const action = prompt(
    `"${s.title}"\n\n1 = Rename\n2 = Hapus\n\nKetik angka:`,
    '1'
  );
  if (action === '1') {
    const name = prompt('Judul baru:', s.title);
    if (name && name.trim()) {
      s.title = name.trim();
      dbPut('series', s).then(refreshLibrary).then(() => toast('Judul diubah'));
    }
  } else if (action === '2') {
    if (confirm(`Hapus "${s.title}" beserta semua chapter?`)) {
      deleteSeries(s).then(() => toast('Dihapus'));
    }
  }
}

async function deleteSeries(s) {
  const chs = chapterCache.filter((c) => c.seriesId === s.id);
  for (const c of chs) await dbDel('chapters', c.id);
  await dbDel('series', s.id);
  await refreshLibrary();
}

/* ---------------- import flow ---------------- */

let pendingPages = null;
let pendingKind = null;

function openImport() {
  $('#inp-series').value = '';
  $('#inp-chapter').value = '';
  pendingPages = null;
  pendingKind = null;
  $('#import-modal').classList.add('open');
}

async function handleArchivePick(files) {
  if (!files.length) return;
  toast('Membaca arsip…', 60000);
  try {
    const allPages = [];
    for (const f of files) {
      const pages = await extractFromArchive(f);
      allPages.push(...pages);
      // prefill title from filename if empty
      if (!$('#inp-series').value) {
        $('#inp-series').value = f.name.replace(/\.(cbz|zip)$/i, '');
      }
    }
    pendingPages = allPages;
    pendingKind = 'archive';
    toast(`${allPages.length} halaman siap diimpor`);
  } catch (err) {
    console.error(err);
    toast('Gagal membaca arsip: ' + err.message);
  }
}

async function handleImagePick(files) {
  if (!files.length) return;
  const pages = await extractFromFiles(files);
  pendingPages = pages;
  pendingKind = 'images';
  toast(`${pages.length} gambar siap diimpor`);
}

async function commitImport() {
  const title = $('#inp-series').value.trim();
  const chapterName = $('#inp-chapter').value.trim() || 'Chapter 1';

  if (!title) { toast('Judul seri wajib diisi'); return; }
  if (!pendingPages || !pendingPages.length) { toast('Belum ada file dipilih'); return; }

  toast('Menyimpan…', 60000);
  try {
    await importChapter({ title, chapterName, pages: pendingPages });
    $('#import-modal').classList.remove('open');
    pendingPages = null;
    await refreshLibrary();
    toast('Berhasil diimpor');
  } catch (err) {
    console.error(err);
    toast('Gagal menyimpan: ' + err.message);
  }
}

/* ---------------- boot ---------------- */

async function boot() {
  await openDB();
  await loadSettings();
  await refreshLibrary();

  // wire library UI
  $('#btn-import').onclick = openImport;
  $('#btn-import-close').onclick = () => $('#import-modal').classList.remove('open');
  $('#btn-pick-archive').onclick = () => $('#file-archive').click();
  $('#btn-pick-images').onclick = () => $('#file-images').click();

  $('#file-archive').onchange = async (e) => {
    await handleArchivePick(e.target.files);
    e.target.value = '';
    if (pendingPages) commitImport();
  };
  $('#file-images').onchange = async (e) => {
    await handleImagePick(e.target.files);
    e.target.value = '';
    if (pendingPages) commitImport();
  };

  // settings sheet
  $('#btn-settings').onclick = () => {
    $('#set-mode').value = settings.mode;
    $('#set-direction').value = settings.direction;
    $('#set-fit').value = settings.fit;
    $('#set-webtoon-width').value = settings.webtoonWidth;
    $('#settings').classList.add('open');
  };
  $('#btn-settings-close').onclick = () => $('#settings').classList.remove('open');

  $('#set-mode').onchange = (e) => saveSetting('mode', e.target.value);
  $('#set-direction').onchange = (e) => saveSetting('direction', e.target.value);
  $('#set-fit').onchange = (e) => saveSetting('fit', e.target.value);
  $('#set-webtoon-width').oninput = (e) => {
    saveSetting('webtoonWidth', Number(e.target.value));
    document.documentElement.style.setProperty('--webtoon-w', e.target.value + '%');
  };

  $('#btn-clear-all').onclick = async () => {
    if (!confirm('Hapus SEMUA data (seri, chapter, progres)? Tidak bisa dibatalkan.')) return;
    for (const c of chapterCache) await dbDel('chapters', c.id);
    for (const s of seriesCache) await dbDel('series', s.id);
    await refreshLibrary();
    toast('Semua data dihapus');
  };

  document.documentElement.style.setProperty('--webtoon-w', settings.webtoonWidth + '%');

  // register service worker for offline
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW gagal:', e));
  }
}

boot();
