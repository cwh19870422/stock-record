// 每天收盤後：用 pm/patterns.json 的走勢樣板掃全部台股 → pm/similar.json
// 另外輸出 pm/closes.json（每檔近 60 天收盤），給 K 線頁「找相似走勢」在手機上即時比對
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('pm/patterns.json', 'utf8'));
const list = JSON.parse(fs.readFileSync('k/list.json', 'utf8'));
const norm = a => { const m = a.reduce((s, x) => s + x, 0) / a.length, sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1; return a.map(x => (x - m) / sd); };
const corr = (a, t) => { const x = norm(a); return x.reduce((s, v, i) => s + v * t[i], 0) / x.length; };
const ma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
// 轉折波：收盤跌破 5MA → 往左取最高點（含上影線、含跌破那根）為「頭」；收盤突破 5MA → 往左取最低點（含下影線）為「底」
function waves(b) {
  const C = b.map(r => r[4]), H = b.map(r => r[2]), Lo = b.map(r => r[3]), out = []; let st = null, seg = 4;
  for (let i = 4; i < b.length; i++) {
    const up = C[i] >= ma(C, 5, i);
    if (st === null) { st = up; seg = i; continue; }
    if (st && !up) { let k = seg; for (let j = seg; j <= i; j++) if (H[j] >= H[k]) k = j; out.push({ t: 'H', i: k, v: H[k] }); st = false; seg = i; }
    else if (!st && up) { let k = seg; for (let j = seg; j <= i; j++) if (Lo[j] <= Lo[k]) k = j; out.push({ t: 'L', i: k, v: Lo[k] }); st = true; seg = i; }
  }
  return out;
}
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
let asOf = '';
const all = [];
for (const [code, name, mkt, ind] of list) {
  let j; try { j = JSON.parse(fs.readFileSync(`k/${code}.json`, 'utf8')); } catch { continue; }
  if (!j.b?.length) continue;
  if (j.b.at(-1)[0] > asOf) asOf = j.b.at(-1)[0];
  all.push({ code, name, mkt, ind, b: j.b });
}
const fresh = d => (Date.parse(asOf) - Date.parse(d)) / 864e5 <= 4; // 太久沒交易的不算
const closes = {};
for (const s of all) {
  const B = s.b.slice(-60); if (B.length < 30 || !fresh(B.at(-1)[0])) continue;
  const amt = B.slice(-20).reduce((t, r) => t + r[4] * r[5], 0) / 20 / 1e5; // 近 20 日平均成交值（億）
  closes[s.code] = [r2(amt), B.at(-1)[0], ...B.map(r => r[4])];
}
fs.writeFileSync('pm/closes.json', JSON.stringify({ asOf, s: closes }));
const out = { asOf, updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), patterns: [] };
for (const p of P) {
  const R = p.rule, N = p.N, items = [];
  for (const s of all) {
    const b = s.b; if (b.length < 60 || !fresh(b.at(-1)[0]) || /^00/.test(s.code)) continue; // 排除 ETF
    const C = b.map(r => r[4]), Lo = b.map(r => r[3]), V = b.map(r => r[5]), L = C.length - 1, W = waves(b);
    const Hs = W.filter(w => w.t === 'H'), Ls = W.filter(w => w.t === 'L'), h1 = Hs.at(-1), h0 = Hs.at(-2), l1 = Ls.at(-1), l0 = Ls.at(-2);
    if (!(h1 && h0 && l1 && l0 && h1.v > h0.v && l1.v > l0.v)) continue;            // 頭頭高、底底高
    if (Math.min(...Lo.slice(l1.i + 1)) <= l1.v) continue;                             // 不破前底（含下影線）
    let below = 0; for (let i = L; i > L - 10; i--) { if (C[i] < ma(C, 20, i)) below++; else break; }
    if (below > R.maxBelow20 || !(ma(C, 20, L) > ma(C, 20, L - 5))) continue;          // 跌破月線不超過 3 天、月線上彎
    const vol20 = V.slice(-20).reduce((t, x) => t + x, 0) / 20; if (vol20 < R.minVol) continue;
    const sim = p.tpl.reduce((t, tp) => t + corr(C.slice(-N), tp), 0) / p.tpl.length; if (sim < R.minSim) continue;
    items.push({ code: s.code, name: s.name, mkt: s.mkt, ind: s.ind, d: b.at(-1)[0], c: C[L], head: h1.v, low: l1.v, sim: r2(sim), vol: Math.round(vol20), score: r2(sim) });
  }
  items.sort((a, b) => b.score - a.score);
  out.patterns.push({ id: p.id, name: p.name, desc: p.desc, from: p.from, items: items.slice(0, 40) });
  console.log(`${p.name}：${items.length} 檔`, items.slice(0, 10).map(x => x.name).join('、'));
}
fs.writeFileSync('pm/similar.json', JSON.stringify(out));
