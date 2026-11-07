/* ============================================================
   Manga Reader — reader engine
   Webtoon (vertical scroll) + Paged (tap/zoom), lazy loading,
   blob URL lifecycle, progress persistence.
   ============================================================ */

'use strict';

/* ---------------- reader state ---------------- */

const reader = {
  series: null,
  chapter: null,
  chapters: [],
  mode: 'webtoon',        // webtoon | paged
  direction: 'ltr',       // ltr | rtl
  fit: 'width',
  pageIndex: 0,
  liveUrls: new Set(),    // blob URLs currently in the DOM
  observer: null,
  uiHidden: false,
  scrollRaf: 0,
};

/* ---------------- view switching ---------------- */

function showView(id) {
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#' + id).classList.add('active');
}

/* ---------------- open a series ---------------- */

async function openSeries(s) {
  const chs = chapterCache
    .filter((c) => c.seriesId === s.id)
    .sort((a, b) => naturalCompare(a.name, b.name));

  if (!chs.length) { toast('Seri ini belum punya chapter'); return; }

  // resume last chapter, else first
  let target = chs.find((c) => c.id === s.lastChapterId) || chs[0];
  await openChapter(s, target, chs);
}

async function openChapter(s, ch, chs) {
  reader.series = s;
  reader.chapter = ch;
  reader.chapters = chs;
  reader.mode = settings.mode;
  reader.direction = settings.direction;
  reader.fit = settings.fit;
  reader.pageIndex = ch.lastPage || 0;

  $('#rt-series').textContent = s.title;
  $('#rt-chapter').textContent = ch.name;
  $('#page-total').textContent = ch.pageCount;

  showView('view-reader');
  document.body.classList.toggle('ui-hidden', false);
  reader.uiHidden = false;

  buildChapterList();

  if (reader.mode === 'webtoon') {
    await renderWebtoon();
  } else {
    await renderPaged();
  }
  updateNavButtons();
}

/* ---------------- chapter list drawer ---------------- */

function buildChapterList() {
  const list = $('#chapter-list');
  list.innerHTML = '';
  $('#drawer-title').textContent = reader.series.title;

  reader.chapters.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'chapter-item' + (c.id === reader.chapter.id ? ' current' : '');
    const pct = c.pageCount ? Math.round(((c.lastPage || 0) / c.pageCount) * 100) : 0;
    item.innerHTML = `<span></span><span class="pg">${c.pageCount} hal${pct ? ' · ' + pct + '%' : ''}</span>`;
    item.firstChild.textContent = c.name;
    item.onclick = async () => {
      $('#drawer').classList.remove('open');
      const chs = reader.chapters;
      await openChapter(reader.series, c, chs);
    };
    list.appendChild(item);
  });
}

/* ---------------- blob URL management ---------------- */

function makeUrl(blob) {
  const u = URL.createObjectURL(blob);
  reader.liveUrls.add(u);
  return u;
}

function revokeUrl(u) {
  if (reader.liveUrls.has(u)) {
    URL.revokeObjectURL(u);
    reader.liveUrls.delete(u);
  }
}

function revokeAll() {
  reader.liveUrls.forEach((u) => URL.revokeObjectURL(u));
  reader.liveUrls.clear();
}

/* ---------------- WEBTOON MODE ---------------- */

async function renderWebtoon() {
  const scroll = $('#reader-scroll');
  const paged = $('#reader-paged');
  paged.classList.remove('show');
  scroll.classList.add('show');
  scroll.innerHTML = '';
  revokeAll();

  const pages = reader.chapter.pages;
  const frag = document.createDocumentFragment();

  pages.forEach((blob, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.index = i;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = `Halaman ${i + 1}`;
    img.dataset.index = i;
    img.className = 'pending';
    wrap.appendChild(img);
    frag.appendChild(wrap);
  });

  scroll.appendChild(frag);

  // Lazy-load: only assign blob URL when near viewport, revoke when far away
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const img = en.target;
      const idx = Number(img.dataset.index);

      if (en.isIntersecting) {
        if (img.dataset.loaded === '1') return;
        const url = makeUrl(pages[idx]);
        img.src = url;
        img.dataset.url = url;
        img.dataset.loaded = '1';
        img.classList.remove('pending');
      } else {
        // far outside the viewport: drop the blob URL so memory stays flat
        if (img.dataset.loaded === '1' && img.dataset.url) {
          revokeUrl(img.dataset.url);
          delete img.dataset.url;
          delete img.dataset.loaded;
          img.removeAttribute('src');
          img.classList.add('pending');
        }
      }
    });
  }, { root: scroll, rootMargin: '1200px 0px' });

  scroll.querySelectorAll('img').forEach((img) => io.observe(img));
  reader.observer = io;

  // restore scroll position (proportional to page index)
  requestAnimationFrame(() => {
    const target = scroll.querySelector(`.page-wrap[data-index="${reader.pageIndex}"]`);
    if (target) scroll.scrollTop = target.offsetTop;
  });

  // track current page while scrolling
  scroll.onscroll = () => {
    if (reader.scrollRaf) return;
    reader.scrollRaf = requestAnimationFrame(() => {
      reader.scrollRaf = 0;
      const mid = scroll.scrollTop + scroll.clientHeight * 0.4;
      const wraps = scroll.querySelectorAll('.page-wrap');
      let cur = 0;
      for (const w of wraps) {
        if (w.offsetTop <= mid) cur = Number(w.dataset.index);
        else break;
      }
      if (cur !== reader.pageIndex) {
        reader.pageIndex = cur;
        $('#page-now').textContent = cur + 1;
        scheduleProgressSave();
      }
    });
  };

  $('#page-now').textContent = (reader.pageIndex || 0) + 1;
  attachTapToggle(scroll);
}

/* ---------------- PAGED MODE ---------------- */

let pagedZoom = 1;
let pagedOffset = { x: 0, y: 0 };

async function renderPaged() {
  const scroll = $('#reader-scroll');
  const paged = $('#reader-paged');
  scroll.classList.remove('show');
  scroll.onscroll = null;
  paged.classList.add('show');
  paged.innerHTML = '';
  revokeAll();
  pagedZoom = 1;
  pagedOffset = { x: 0, y: 0 };

  // fit class on container
  paged.className = 'reader-paged show fit-' + reader.fit;

  const wrap = document.createElement('div');
  wrap.className = 'page-wrap';

  const img = document.createElement('img');
  img.alt = 'Halaman';
  wrap.appendChild(img);
  paged.appendChild(wrap);

  // tap zones
  const zl = document.createElement('div');
  zl.className = 'tap-zone tap-left';
  const zr = document.createElement('div');
  zr.className = 'tap-zone tap-right';
  const zm = document.createElement('div');
  zm.className = 'tap-zone tap-mid';
  paged.appendChild(zl); paged.appendChild(zr); paged.appendChild(zm);

  zl.onclick = () => stepPage(reader.direction === 'rtl' ? +1 : -1);
  zr.onclick = () => stepPage(reader.direction === 'rtl' ? -1 : +1);
  zm.onclick = () => toggleUI();

  // gestures
  attachGestures(paged, wrap, img);

  await loadPagedImage(img);
  $('#page-now').textContent = reader.pageIndex + 1;
}

async function loadPagedImage(img) {
  const pages = reader.chapter.pages;
  const idx = Math.min(reader.pageIndex, pages.length - 1);
  const url = makeUrl(pages[idx]);
  img.src = url;
  img.dataset.loaded = '1';
  // revoke the previous page's URL to keep memory flat
  if (img.dataset.prevUrl) revokeUrl(img.dataset.prevUrl);
  img.dataset.prevUrl = url;
  img.style.transform = 'translate(0,0) scale(1)';
  pagedZoom = 1;
  pagedOffset = { x: 0, y: 0 };
}

function stepPage(delta) {
  const pages = reader.chapter.pages;
  const next = reader.pageIndex + delta;

  if (next < 0) {
    // previous chapter
    const i = reader.chapters.findIndex((c) => c.id === reader.chapter.id);
    if (i > 0) {
      openChapter(reader.series, reader.chapters[i - 1], reader.chapters);
    } else {
      toast('Chapter pertama');
    }
    return;
  }
  if (next >= pages.length) {
    const i = reader.chapters.findIndex((c) => c.id === reader.chapter.id);
    if (i < reader.chapters.length - 1) {
      openChapter(reader.series, reader.chapters[i + 1], reader.chapters);
    } else {
      toast('Chapter terakhir');
    }
    return;
  }

  reader.pageIndex = next;
  $('#page-now').textContent = next + 1;
  const img = $('#reader-paged img');
  if (img) loadPagedImage(img);
  scheduleProgressSave();
}

/* ---------------- gestures: pinch + double tap ---------------- */

function attachGestures(container, wrap, img) {
  let startDist = 0;
  let startZoom = 1;
  let lastTap = 0;

  const dist = (t1, t2) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      startDist = dist(e.touches[0], e.touches[1]);
      startZoom = pagedZoom;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist) {
      const d = dist(e.touches[0], e.touches[1]);
      pagedZoom = Math.min(5, Math.max(1, startZoom * (d / startDist)));
      img.style.transform = `translate(${pagedOffset.x}px, ${pagedOffset.y}px) scale(${pagedZoom})`;
      e.preventDefault();
    }
  }, { passive: false });

  container.addEventListener('touchend', () => {
    if (pagedZoom <= 1.02) {
      pagedZoom = 1;
      pagedOffset = { x: 0, y: 0 };
      img.style.transform = 'translate(0,0) scale(1)';
    }
    startDist = 0;
  });

  // double tap zoom
  container.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lastTap < 300) {
      if (pagedZoom > 1.5) {
        pagedZoom = 1; pagedOffset = { x: 0, y: 0 };
        img.style.transform = 'translate(0,0) scale(1)';
      } else {
        pagedZoom = 2.2;
        img.style.transform = `translate(0,0) scale(2.2)`;
      }
      e.stopPropagation();
    }
    lastTap = now;
  }, true);
}

/* ---------------- UI toggle ---------------- */

function toggleUI() {
  reader.uiHidden = !reader.uiHidden;
  document.body.classList.toggle('ui-hidden', reader.uiHidden);
}

function attachTapToggle(el) {
  // in webtoon mode, a single tap on the image area toggles the toolbar
  let startY = 0, startT = 0, moved = false;
  el.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY; startT = Date.now(); moved = false;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (Math.abs(e.touches[0].clientY - startY) > 12) moved = true;
  }, { passive: true });
  el.addEventListener('touchend', () => {
    if (!moved && Date.now() - startT < 250) toggleUI();
  });
}

/* ---------------- progress persistence ---------------- */

let saveTimer = 0;
function scheduleProgressSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 600);
}

async function saveProgress() {
  if (!reader.chapter) return;
  const ch = reader.chapter;
  ch.lastPage = reader.pageIndex;
  await dbPut('chapters', ch);

  const s = reader.series;
  s.lastChapterId = ch.id;
  s.lastPage = reader.pageIndex;
  s.lastReadAt = Date.now();
  await dbPut('series', s);
}

/* ---------------- chapter navigation ---------------- */

function updateNavButtons() {
  const i = reader.chapters.findIndex((c) => c.id === reader.chapter.id);
  $('#btn-prev-ch').disabled = i <= 0;
  $('#btn-next-ch').disabled = i >= reader.chapters.length - 1;
}

function gotoChapterOffset(delta) {
  const i = reader.chapters.findIndex((c) => c.id === reader.chapter.id);
  const t = i + delta;
  if (t < 0 || t >= reader.chapters.length) return;
  openChapter(reader.series, reader.chapters[t], reader.chapters);
}

/* ---------------- reader wiring ---------------- */

function wireReader() {
  $('#btn-back').onclick = async () => {
    await saveProgress();
    revokeAll();
    if (reader.observer) { reader.observer.disconnect(); reader.observer = null; }
    showView('view-library');
    await refreshLibrary();
  };

  $('#btn-chapters').onclick = () => $('#drawer').classList.add('open');
  $('#btn-drawer-close').onclick = () => $('#drawer').classList.remove('open');

  $('#btn-prev-ch').onclick = () => gotoChapterOffset(-1);
  $('#btn-next-ch').onclick = () => gotoChapterOffset(+1);

  // swipe left/right in paged mode is handled by tap zones; also support
  // keyboard for desktop testing
  document.addEventListener('keydown', (e) => {
    if (!$('#view-reader').classList.contains('active')) return;
    if (e.key === 'ArrowRight') stepPage(reader.direction === 'rtl' ? -1 : +1);
    if (e.key === 'ArrowLeft')  stepPage(reader.direction === 'rtl' ? +1 : -1);
    if (e.key === 'Escape') $('#btn-back').click();
  });

  // save progress when leaving the tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveProgress();
  });
}
