// 自選股：資料存在 Cloudflare（以同步碼區分），手機電腦共用；本機也留一份備份
// 結構：{ updated, cats: [{ id, name, groups: [{ id, name, codes: [] }] }] }
window.WL = (() => {
  const API = 'https://tw-rt.cwh19870422.workers.dev/wl/';
  const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join('');
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  // 同步碼：網址帶 ?sync= 就採用（用來把另一台裝置連上同一份清單）
  const fromUrl = new URLSearchParams(location.search).get('sync');
  if (fromUrl && /^[A-Za-z0-9_-]{24,64}$/.test(fromUrl)) { ls.set('wl-id', fromUrl); history.replaceState(null, '', location.pathname + location.search.replace(/[?&]sync=[^&]+/, '').replace(/^&/, '?')); }
  let id = ls.get('wl-id'); if (!id) { id = rid(32); ls.set('wl-id', id); }
  const fresh = () => ({ updated: 0, cats: [{ id: rid(8), name: '預設', groups: [{ id: rid(8), name: '我的', codes: [] }] }] });
  let data = (() => { try { return JSON.parse(ls.get('wl-data')) || fresh(); } catch { return fresh(); } })();
  const subs = [];
  let status = '同步中…';
  const emit = () => subs.forEach(f => f(data, status));
  async function load() {
    try {
      const r = await fetch(API + id, { cache: 'no-store' }), remote = await r.json();
      if (remote?.cats?.length && (remote.updated || 0) >= (data.updated || 0)) data = remote;
      else if (data.updated) await push();
      ls.set('wl-data', JSON.stringify(data)); status = '已同步';
    } catch { status = '離線（暫存在本機）'; }
    emit(); return data;
  }
  let timer;
  async function push() {
    try { const r = await fetch(API + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); status = r.ok ? '已同步' : '同步失敗'; }
    catch { status = '離線（暫存在本機）'; }
    emit();
  }
  function save() { data.updated = Date.now(); ls.set('wl-data', JSON.stringify(data)); status = '同步中…'; emit(); clearTimeout(timer); timer = setTimeout(push, 400); }
  const groups = () => data.cats.flatMap(c => c.groups.map(g => ({ ...g, cat: c })));
  const groupsOf = code => groups().filter(g => g.codes.includes(code)).map(g => g.id);
  const findG = gid => { for (const c of data.cats) for (const g of c.groups) if (g.id === gid) return g; return null; };
  function setMembership(code, gids) { data.cats.forEach(c => c.groups.forEach(g => { const has = g.codes.includes(code), want = gids.includes(g.id); if (want && !has) g.codes.unshift(code); if (!want && has) g.codes = g.codes.filter(x => x !== code); })); save(); }
  const addCat = name => { const c = { id: rid(8), name, groups: [{ id: rid(8), name: '清單', codes: [] }] }; data.cats.push(c); save(); return c; };
  const addGroup = (cid, name) => { const c = data.cats.find(x => x.id === cid); const g = { id: rid(8), name, codes: [] }; c.groups.push(g); save(); return g; };
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // ---- 共用彈出視窗（不使用瀏覽器 alert／prompt）----
  const css = `.wlm{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:50;display:flex;align-items:flex-end;justify-content:center}
.wlm .bx{background:#17243d;border:1px solid #26375a;border-radius:16px 16px 0 0;width:100%;max-width:520px;max-height:80vh;overflow:auto;padding:16px 16px calc(16px + env(safe-area-inset-bottom));color:#e8eef8}
.wlm h3{margin:0 0 10px;font-size:17px}.wlm .cat{color:#93a3bf;font-size:13px;margin:12px 0 4px}
.wlm label{display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid #22314f;font-size:15px}
.wlm input[type=checkbox]{width:20px;height:20px;accent-color:#F0E442}
.wlm input[type=text]{flex:1;background:#0f1a2e;color:#e8eef8;border:1px solid #26375a;border-radius:8px;padding:8px;font-size:16px;min-width:0}
.wlm .row{display:flex;gap:8px;margin-top:8px}.wlm button{background:#26375a;color:#e8eef8;border:0;border-radius:10px;padding:9px 14px;font-size:14px;cursor:pointer}
.wlm button.pri{background:#F0E442;color:#1a1a1a;font-weight:700}.wlm button.del{background:transparent;color:#ff7a7a;padding:6px 8px}
.wlm .foot{display:flex;gap:8px;margin-top:14px}.wlm .foot button{flex:1}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  function modal(html, onMount) {
    const m = document.createElement('div'); m.className = 'wlm'; m.innerHTML = `<div class="bx">${html}</div>`;
    m.addEventListener('click', e => { if (e.target === m) m.remove(); });
    document.body.appendChild(m); onMount?.(m, () => m.remove()); return m;
  }
  // 加入／移出分類（可多選，也可直接新增分類）
  function pick(code, name, done) {
    let sel = new Set(groupsOf(code));
    const body = () => data.cats.map(c => `<div class="cat">📁 ${esc(c.name)}</div>${c.groups.map(g => `<label><input type="checkbox" data-g="${g.id}"${sel.has(g.id) ? ' checked' : ''}>${esc(g.name)}<span style="margin-left:auto;color:#93a3bf;font-size:12px">${g.codes.length} 檔</span></label>`).join('')}
      <div class="row"><input type="text" placeholder="在「${esc(c.name)}」新增分類" data-new="${c.id}"><button data-add="${c.id}">新增</button></div>`).join('');
    modal(`<h3>☆ ${esc(name)} 加入自選</h3><div id="wlb">${body()}</div>
      <div class="foot"><button id="wlc">取消</button><button class="pri" id="wlo">完成</button></div>`, (m, close) => {
      const rebind = () => {
        m.querySelectorAll('[data-g]').forEach(i => i.onchange = () => i.checked ? sel.add(i.dataset.g) : sel.delete(i.dataset.g));
        m.querySelectorAll('[data-add]').forEach(b => b.onclick = () => { const inp = m.querySelector(`[data-new="${b.dataset.add}"]`), v = inp.value.trim(); if (!v) return; const g = addGroup(b.dataset.add, v); sel.add(g.id); m.querySelector('#wlb').innerHTML = body(); rebind(); });
      };
      rebind();
      m.querySelector('#wlc').onclick = close;
      m.querySelector('#wlo').onclick = () => { setMembership(code, [...sel]); close(); done?.(); };
    });
  }
  return { get data() { return data; }, get id() { return id; }, get status() { return status; }, load, save, groups, groupsOf, findG, setMembership, addCat, addGroup, pick, modal, esc, on: f => subs.push(f), syncUrl: () => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}watch.html?sync=${id}` };
})();
