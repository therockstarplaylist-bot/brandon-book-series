
/* Native Android Read-Aloud bridge (screen-off TTS via Foreground Service) */
window.__nativeTTS = !!(window.BookSeriesBridge && BookSeriesBridge.speak);
window.nativeSpeak = function(text, rate){
  if (window.BookSeriesBridge && BookSeriesBridge.speak) {
    try { BookSeriesBridge.speak(String(text||''), Number(rate||1)); return true; } catch(e) {}
  }
  return false;
};
window.nativeStopSpeak = function(){
  if (window.BookSeriesBridge && BookSeriesBridge.stopSpeak) {
    try { BookSeriesBridge.stopSpeak(); return true; } catch(e) {}
  }
  return false;
};
window.onNativeUtteranceDone = window.onNativeUtteranceDone || function(){
  if (window.__readAloudAdvance) try { window.__readAloudAdvance(); } catch(e) {}
};


(() => {
  const DATA = 'data';
  const state = {
    manifest: null,
    book: null,
    bookId: null,
    spot: null,
    sentences: [],
    sentIdx: 0,
    speaking: false,
    rate: 1,
    glossary: {},
  };

  const $ = (s, el=document) => el.querySelector(s);
  const $$ = (s, el=document) => [...el.querySelectorAll(s)];
  const main = $('#main');
  const toast = (msg) => {
    const t = document.createElement('div');
    t.className = 'copy-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1200);
  };

  async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error('load fail ' + path);
    return r.json();
  }
  async function loadChunk(rel) {
    const r = await fetch(DATA + '/' + rel);
    if (!r.ok) throw new Error('chunk ' + rel);
    // chunks are gzip; browsers auto-decode Content-Encoding if served gzipped,
    // but static .json.gz needs DecompressionStream or pre-inflated. Serve via fetch arrayBuffer + DecompressionStream.
    const buf = await r.arrayBuffer();
    try {
      const ds = new DecompressionStream('gzip');
      const stream = new Response(buf).body.pipeThrough(ds);
      return await new Response(stream).json();
    } catch (e) {
      // fallback: maybe already json
      return JSON.parse(new TextDecoder().decode(buf));
    }
  }

  function saveSpot() {
    if (!state.bookId) return;
    const payload = { bookId: state.bookId, spot: state.spot, sentIdx: state.sentIdx, t: Date.now() };
    localStorage.setItem('bms_spot_' + state.bookId, JSON.stringify(payload));
    // Android bridge
    if (window.BookSeriesBridge && window.BookSeriesBridge.saveSpot) {
      window.BookSeriesBridge.saveSpot(JSON.stringify(payload));
    }
  }
  function loadSpot(bookId) {
    try { return JSON.parse(localStorage.getItem('bms_spot_' + bookId) || 'null'); } catch { return null; }
  }

  function badgeClass(s) {
    s = (s||'').toLowerCase();
    if (s.includes('shipped')) return 'shipped';
    if (s.includes('arch') || s.includes('proto')) return 'proto';
    return 'concept';
  }

  async function showBookshelf() {
    $('#tts-bar').hidden = true;
    $('#top-title').textContent = 'Book Series';
    if (!state.manifest) state.manifest = await loadJSON(DATA + '/series_manifest.json');
    const books = state.manifest.books.slice().sort((a,b)=>a.number-b.number);
    main.innerHTML = `
      <h1>The Brandon McAllister Archive & Invention Series</h1>
      <p class="ded">${state.manifest.dedication}</p>
      <p class="muted">${state.manifest.book_count} books · corpus ${Number(state.manifest.total_corpus_words).toLocaleString()} words</p>
      <div class="toolbar">
        <button class="btn" id="open-print">Print 49-Page Mini-Book</button>
        <button class="btn secondary" id="open-dict">Open Dictionary</button>
      </div>
      <div class="bookshelf" id="shelf"></div>`;
    const shelf = $('#shelf');
    for (const b of books) {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.innerHTML = `<div class="badge">Book ${b.number}</div><h3>${escapeHtml(b.title)}</h3>
        <div class="sub">${escapeHtml(b.subtitle||'')}</div>
        <div class="muted">${b.chapters} chapters · ~${Number(b.word_count||0).toLocaleString()} words</div>`;
      card.onclick = () => openBook(b.id);
      shelf.appendChild(card);
    }
    $('#open-print').onclick = () => { $('#print-modal').hidden = false; };
    $('#open-dict').onclick = () => openBook('book-dict');
    buildGlobalToc(books);
  }

  function escapeHtml(s) {
    return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function buildGlobalToc(books) {
    const tree = $('#toc-tree');
    tree.innerHTML = '';
    for (const b of books) {
      const d = document.createElement('details');
      d.innerHTML = `<summary>Book ${b.number}: ${escapeHtml(b.title)}</summary><div class="toc-children" data-book="${b.id}"><span class="muted">Open book to expand chapters…</span></div>`;
      d.querySelector('summary').addEventListener('click', async () => {
        const box = d.querySelector('.toc-children');
        if (box.dataset.loaded) return;
        const book = await loadJSON(DATA + '/' + b.id + '.json');
        box.innerHTML = '';
        for (const ch of book.chapters) {
          const a = document.createElement('a');
          a.href = '#'; a.textContent = ch.title;
          a.onclick = (e) => { e.preventDefault(); openBook(b.id, ch.id); $('#toc-drawer').hidden = true; };
          box.appendChild(a);
        }
        box.dataset.loaded = '1';
      });
      tree.appendChild(d);
    }
  }

  async function openBook(bookId, chapterId) {
    state.bookId = bookId;
    state.book = await loadJSON(DATA + '/' + bookId + '.json');
    if (bookId.startsWith('book-archive-')) {
      try {
        let chapters = [];
        const meta = (state.manifest && (state.manifest.books||[]).find(b => b.id === bookId)) || {};
        const bundles = (state.manifest && state.manifest.archive_bundles) || {};
        const parts = (bundles[bookId] && bundles[bookId].parts) || meta.volume_parts || 1;
        if (parts > 1) {
          const loaded = [];
          for (let i = 1; i <= parts; i++) {
            loaded.push(await loadChunk(bookId + '-full-p' + i + '.json.gz'));
          }
          chapters = loaded.flatMap(x => x.chapters || []);
        } else {
          const full = await loadChunk(bookId + '-full.json.gz');
          chapters = full.chapters || [];
        }
        const byId = Object.fromEntries(chapters.map(c => [c.id, c]));
        state.book.chapters = state.book.chapters.map(ch => {
          const f = byId[ch.id];
          if (!f) return ch;
          const html = ch.html && !ch.html.includes('chunk-host') ? ch.html :
            ('<pre style="white-space:pre-wrap;font-family:Georgia,serif">' + escapeHtml(f.text||'') + '</pre>');
          return {...ch, html, text: f.text};
        });
      } catch (e) { console.warn('full bundle miss', e); }
    }
    $('#top-title').textContent = state.book.title;
    $('#tts-bar').hidden = false;
    const spot = loadSpot(bookId);
    main.innerHTML = `<div class="reader">
      <h1>${escapeHtml(state.book.title)}</h1>
      <p class="ded">${escapeHtml(state.book.dedication||'')}</p>
      <div class="toolbar">
        <button class="btn" id="btn-copy-chapter">Copy chapter</button>
        <button class="btn secondary" id="btn-export-md">Export .md</button>
        <button class="btn secondary" id="btn-print2">Print builder</button>
      </div>
      <div id="chapters"></div>
    </div>`;
    const wrap = $('#chapters');
    for (const ch of state.book.chapters) {
      const sec = document.createElement('section');
      sec.id = ch.id;
      sec.innerHTML = `<h2>${escapeHtml(ch.title)}</h2>
        <div class="toolbar">
          <button class="btn secondary copy-sec">Copy</button>
          <button class="btn secondary export-sec">Export</button>
        </div>
        <div class="sec-body">${ch.html||''}</div>`;
      wrap.appendChild(sec);
      sec.querySelector('.copy-sec').onclick = () => copyText(sec.innerText);
      sec.querySelector('.export-sec').onclick = () => exportText(ch.title + '.md', '# ' + ch.title + '\n\n' + sec.innerText);
      // lazy chunk
      const host = sec.querySelector('[data-chunk]');
      if (host) {
        const rel = host.getAttribute('data-chunk');
        loadChunk(rel).then(payload => {
          host.innerHTML = '<pre style="white-space:pre-wrap;font-family:Georgia,serif">' + escapeHtml(payload.text||'') + '</pre>';
          wireGlossary(sec);
          prepareSentences();
        }).catch(err => { host.textContent = 'Failed to load chapter chunk: ' + err.message; });
      }
    }
    enhanceInteractive(main);
    wireGlossary(main);
    $('#btn-copy-chapter').onclick = () => copyText(main.innerText);
    $('#btn-export-md').onclick = () => exportText(state.book.id + '.md', main.innerText);
    $('#btn-print2').onclick = () => { $('#print-modal').hidden = false; };
    prepareSentences();
    if (chapterId) {
      const el = document.getElementById(chapterId);
      if (el) el.scrollIntoView({behavior:'smooth', block:'start'});
    } else if (spot && spot.spot) {
      const el = document.getElementById(spot.spot);
      if (el) el.scrollIntoView();
    }
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copied!')).catch(() => toast('Copy failed'));
  }
  function exportText(name, text) {
    const blob = new Blob([text], {type:'text/markdown'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    toast('Exported');
  }

  function wireGlossary(root) {
    // simplistic: wrap known terms from dictionary book if loaded
  }

  function enhanceInteractive(root) {
    $$('.matrix-grid', root).forEach(grid => {
      if (grid.dataset.ready) return;
      grid.dataset.ready = '1';
      const n = grid.getAttribute('data-table') || '1';
      const labels = ['A','B','C','D','E','F','G','H','Z'];
      labels.forEach((lab,i) => {
        const cell = document.createElement('div');
        cell.className = 'matrix-cell';
        cell.contentEditable = 'true';
        cell.textContent = `T${n}:${lab}`;
        grid.appendChild(cell);
      });
    });
    $$('.math-player', root).forEach(setupMathPlayer);
    $$('.pipeline-runner', root).forEach(el => {
      el.innerHTML = `<p>Live A/B → C → D/E → Z</p>
        <label>A <input id="pA" type="number" value="3"/></label>
        <label>B <input id="pB" type="number" value="6"/></label>
        <button class="btn" id="pRun">Run</button>
        <pre id="pOut"></pre>`;
      el.querySelector('#pRun').onclick = () => {
        const A = +el.querySelector('#pA').value, B = +el.querySelector('#pB').value;
        const C = A + B; const D = C % 9 || 9; const E = (A*B)%9||9; const Z = (D+E)%9||9;
        el.querySelector('#pOut').textContent = `A=${A} B=${B} → C=${C} → D=${D} E=${E} → Z=${Z}`;
      };
    });
    $$('.botstage-sim', root).forEach(el => {
      el.innerHTML = `<p>Training Room → Stage</p><button class="btn" id="bsGo">Train specialist</button><pre id="bsLog"></pre>`;
      const log = [];
      el.querySelector('#bsGo').onclick = () => {
        log.push('Bot enters Training Room…'); log.push('Practice: tool use + soul-gate checks'); log.push('Pass rehearsal → promoted to Stage');
        el.querySelector('#bsLog').textContent = log.join('\n');
      };
    });
    $$('.ubtf-explorer', root).forEach(el => {
      el.innerHTML = `<details open><summary>Root</summary><details open><summary>Seek truth</summary><p>Ask · Verify · Log</p></details><details><summary>Protect creator</summary><p>Non-harm gate</p></details></details>`;
    });
    $$('.sovereign-diagram', root).forEach(el => {
      el.innerHTML = `<pre>Agent Loop → Soul Lock → Growth Gate → Telemetry
TAMPER_BLOCKED keeps hash stable
0.5% steps only inside stability band</pre>`;
    });
    $$('.demo-btn', root).forEach(btn => {
      btn.onclick = () => toast('Demo wired: ' + btn.getAttribute('data-demo'));
    });
  }

  function setupMathPlayer(box) {
    if (box.dataset.ready) return;
    box.dataset.ready = '1';
    const name = box.getAttribute('data-name') || 'Math';
    const canvas = document.createElement('canvas');
    canvas.width = 420; canvas.height = 220;
    const controls = document.createElement('div');
    controls.className = 'math-controls';
    controls.innerHTML = `
      <button class="btn" data-act="play">Play</button>
      <button class="btn secondary" data-act="pause">Pause</button>
      <button class="btn secondary" data-act="slow">0.5x</button>
      <button class="btn secondary" data-act="norm">1x</button>
      <button class="btn secondary" data-act="fast">2x</button>
      <button class="btn secondary" data-act="prev">Prev</button>
      <button class="btn secondary" data-act="next">Next</button>`;
    const caption = document.createElement('p');
    caption.className = 'muted';
    box.appendChild(canvas); box.appendChild(controls); box.appendChild(caption);
    const ctx = canvas.getContext('2d');
    let step = 0, timer = null, speed = 1;
    const frames = buildFrames(name);
    const draw = () => {
      const f = frames[step % frames.length];
      ctx.fillStyle = '#070b14'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.strokeStyle = '#6ea8fe'; ctx.fillStyle = '#e8eefc';
      f.draw(ctx, canvas);
      caption.textContent = f.caption;
    };
    const play = () => {
      if (timer) return;
      timer = setInterval(() => { step++; draw(); }, 700 / speed);
    };
    const pause = () => { clearInterval(timer); timer = null; };
    controls.onclick = (e) => {
      const act = e.target.getAttribute('data-act'); if (!act) return;
      if (act==='play') play();
      if (act==='pause') pause();
      if (act==='slow') { speed=0.5; pause(); play(); }
      if (act==='norm') { speed=1; pause(); play(); }
      if (act==='fast') { speed=2; pause(); play(); }
      if (act==='prev') { pause(); step=Math.max(0,step-1); draw(); }
      if (act==='next') { pause(); step++; draw(); }
    };
    draw();
  }

  function buildFrames(name) {
    const n = (name||'').toLowerCase();
    if (n.includes('collatz')) {
      let x = 27;
      const seq = [x];
      for (let i=0;i<20;i++){ x = x%2? 3*x+1 : x/2; seq.push(x); }
      return seq.map((v,i)=>({
        caption: `Step ${i}: value ${v} — ${v%2?'3n+1':'n/2'}`,
        draw: (ctx,c)=>{ ctx.beginPath(); ctx.arc(40+i*16, 180-Math.min(160,v/2), 8,0,6.28); ctx.fill();
          ctx.fillText(String(v), 30+i*16, 200); }
      }));
    }
    if (n.includes('369') || n.includes('digital')) {
      return [0,1,2,3,4,5,6,7,8].map(i=>({
        caption: `Digital-root ring position ${i+1} (3-6-9 highlights)`,
        draw:(ctx,c)=>{
          const cx=210,cy=110,r=70;
          for(let k=0;k<9;k++){
            const a=-Math.PI/2+k*2*Math.PI/9;
            const x=cx+r*Math.cos(a), y=cy+r*Math.sin(a);
            ctx.beginPath(); ctx.arc(x,y,10,0,6.28);
            ctx.strokeStyle = ([2,5,8].includes(k) && k<=i)? '#ffc857':'#6ea8fe';
            ctx.stroke();
            ctx.fillText(String(k+1), x-4, y+4);
          }
        }
      }));
    }
    if (n.includes('matrix') || n.includes('3')) {
      return [0,1,2,3,4].map(i=>({
        caption: `Routing tokens through tray cells (frame ${i+1})`,
        draw:(ctx)=>{
          for(let r=0;r<3;r++) for(let c=0;c<3;c++){
            const on = (r*3+c)<=i;
            ctx.strokeStyle=on?'#3ddc97':'#6ea8fe';
            ctx.strokeRect(80+c*80,30+r*55,70,45);
          }
        }
      }));
    }
    // default wave / tensor-ish
    return [0,1,2,3,4,5,6,7].map(i=>({
      caption: `${name}: demonstration frame ${i+1}/8`,
      draw:(ctx,c)=>{
        ctx.beginPath();
        for(let x=0;x<c.width;x++){
          const y=110+40*Math.sin((x/40)+i/2)*Math.cos((x/90)+i);
          x?ctx.lineTo(x,y):ctx.moveTo(x,y);
        }
        ctx.stroke();
      }
    }));
  }

  function prepareSentences() {
    const text = main.innerText || '';
    state.sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 2);
    state.sentIdx = 0;
  }

  function speakCurrent() {
    if (!state.sentences.length) prepareSentences();
    if (state.sentIdx >= state.sentences.length) {
      // advance chapter if possible
      const sections = $$('.reader section');
      const cur = sections.findIndex(s => s.getBoundingClientRect().top >= -20);
      const next = sections[Math.min(sections.length-1, (cur<0?0:cur)+1)];
      if (next && next !== sections[cur]) {
        next.scrollIntoView({behavior:'smooth'});
        state.spot = next.id; saveSpot();
        setTimeout(() => { prepareSentences(); state.sentIdx=0; if(state.speaking) speakCurrent(); }, 400);
        return;
      }
      state.speaking = false; $('#tts-status').textContent = 'End of book';
      if (window.BookSeriesBridge && window.BookSeriesBridge.stopTts) (window.BookSeriesBridge.stopSpeak?window.BookSeriesBridge.stopSpeak():window.BookSeriesBridge.stopTts&&window.BookSeriesBridge.stopTts());
      return;
    }
    const utter = state.sentences[state.sentIdx];
    $('#tts-status').textContent = `Reading ${state.sentIdx+1}/${state.sentences.length}`;
    state.spot = ($$('.reader section').find(s => s.getBoundingClientRect().top < 120) || {}).id || state.spot;
    saveSpot();
    // Native Android bridge preferred for screen-off
    if (window.BookSeriesBridge && window.BookSeriesBridge.speak) {
      window.BookSeriesBridge.speak(String(utter), String(state.rate));
      clearInterval(window.__ttsPoll);
      window.__ttsPoll = setInterval(() => {
        try {
          if (!state.speaking) { clearInterval(window.__ttsPoll); return; }
          if (window.BookSeriesBridge.isSpeaking && !BookSeriesBridge.isSpeaking()) {
            clearInterval(window.__ttsPoll);
            if (state.speaking) { state.sentIdx++; speakCurrent(); }
          }
        } catch (e) {}
      }, 400);
      return;
    }
    if (!window.speechSynthesis) { toast('TTS unavailable'); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(utter);
    u.rate = state.rate;
    u.onend = () => { if (state.speaking) { state.sentIdx++; speakCurrent(); } };
    window.speechSynthesis.speak(u);
  }

  // Bridge callback from Android when utterance ends
  window.BookSeriesTtsDone = () => { if (state.speaking) { state.sentIdx++; speakCurrent(); } };

  $('#tts-play').onclick = () => { state.speaking = true; state.rate = +$('#tts-rate').value; if (window.BookSeriesBridge && window.BookSeriesBridge.startForeground) window.BookSeriesBridge.startForeground(); speakCurrent(); };
  $('#tts-stop').onclick = () => { state.speaking=false; window.speechSynthesis && speechSynthesis.cancel(); if (window.BookSeriesBridge && window.BookSeriesBridge.stopTts) (window.BookSeriesBridge.stopSpeak?window.BookSeriesBridge.stopSpeak():window.BookSeriesBridge.stopTts&&window.BookSeriesBridge.stopTts()); $('#tts-status').textContent='Stopped'; };
  $('#tts-prev').onclick = () => { state.sentIdx=Math.max(0,state.sentIdx-1); if(state.speaking) speakCurrent(); };
  $('#tts-next').onclick = () => { state.sentIdx++; if(state.speaking) speakCurrent(); };
  $('#tts-rate').onchange = () => { state.rate = +$('#tts-rate').value; };

  $('#btn-home').onclick = () => showBookshelf();
  $('#btn-toc').onclick = () => { $('#toc-drawer').hidden = !$('#toc-drawer').hidden; };
  $('#toc-close').onclick = () => { $('#toc-drawer').hidden = true; };
  $('#btn-search').onclick = () => { $('#search-modal').hidden = false; $('#search-input').focus(); };
  $('#search-close').onclick = () => { $('#search-modal').hidden = true; };
  $('#print-close').onclick = () => { $('#print-modal').hidden = true; };
  $('#print-pdf').onclick = () => { window.open('How_I_Made_This_All_Possible_49p.pdf', '_blank'); };
  $('#print-view').onclick = () => {
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Print ≤49p</title><style>@page{size:letter;margin:.7in} body{font-family:Georgia;font-size:11pt;line-height:1.35;color:#000;background:#fff} h1,h2{page-break-after:avoid} .ded{font-style:italic}</style></head><body>`);
    w.document.write(`<h1>${escapeHtml((state.book&&state.book.title)||'Mini-Book')}</h1><p class="ded">${escapeHtml((state.manifest&&state.manifest.dedication)||'')}</p>`);
    w.document.write((main.innerText||'').slice(0, 45000).replace(/\n/g,'<br/>'));
    w.document.write('</body></html>'); w.document.close(); w.print();
  };

  $('#search-input').oninput = async (e) => {
    const q = e.target.value.trim().toLowerCase();
    const box = $('#search-results'); box.innerHTML='';
    if (!q || !state.manifest) return;
    for (const b of state.manifest.books) {
      if ((b.title||'').toLowerCase().includes(q) || (b.subtitle||'').toLowerCase().includes(q)) {
        const a=document.createElement('div'); a.innerHTML=`<button class="btn">${escapeHtml(b.title)}</button>`;
        a.querySelector('button').onclick=()=>{ $('#search-modal').hidden=true; openBook(b.id); };
        box.appendChild(a);
      }
    }
  };

  $('#btn-open-local').onclick = () => $('#local-file').click();
  $('#local-file').onchange = async (e) => {
    const files = [...e.target.files];
    for (const f of files) {
      const text = await f.text();
      localStorage.setItem('bms_local_' + f.name, text.slice(0, 2_000_000));
      toast('Added ' + f.name);
    }
    $('#search-modal').hidden = true;
    main.insertAdjacentHTML('afterbegin', `<div class="local-note">Loaded local file(s): ${files.map(f=>f.name).join(', ')}. Stored on-device for this browser/app.</div>`);
  };

  $('#g-back').onclick = () => {
    $('#glossary-pop').hidden = true;
    if (state.spot) {
      const el = document.getElementById(state.spot);
      if (el) el.scrollIntoView({behavior:'smooth'});
    }
  };

  // boot
  showBookshelf().catch(err => { main.innerHTML = '<p>Failed to load series: '+escapeHtml(err.message)+'</p>'; console.error(err); });
})();
