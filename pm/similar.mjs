// 每天收盤後：用 pm/patterns.json 的走勢樣板掃全部台股 → pm/similar.json
// 另外輸出 pm/closes.json（每檔近 60 天收盤），給 K 線頁「找相似走勢」在手機上即時比對
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('pm/patterns.json', 'utf8'));
const list = JSON.parse(fs.readFileSync('k/list.json', 'utf8'));
const norm = a => { const m = a.reduce((s, x) => s + x, 0) / a.length, sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) || 1; return a.map(x => (x - m) / sd); };
const corr = (a, t) => { const x = norm(a); return x.reduce((s, v, i) => s + v * t[i], 0) / x.length; };
const ma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
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
    const b = s.b; if (b.length < 60 || !fresh(b.at(-1)[0])) continue;
    const C = b.map(r => r[4]), H = b.map(r => r[2]), V = b.map(r => r[5]), L = C.length - 1;
    let pk = L - 12; for (let i = L - 12; i <= L - 2; i++) if (H[i] > H[pk]) pk = i;
    let lo = L - N + 1; for (let i = L - N + 1; i < pk; i++) if (C[i] < C[lo]) lo = i;
    const rise = H[pk] / C[lo] - 1, back = 1 - C[L] / Math.max(...C.slice(pk - 1, L + 1)), days = L - pk;
    const m20 = ma(C, 20, L), m20p = ma(C, 20, L - 5), m5 = ma(C, 5, L);
    const amt = C.slice(-20).reduce((t, x, i) => t + x * V.at(-20 + i), 0) / 20 / 1e5;
    const vol20 = V.slice(-20).reduce((t, x) => t + x, 0) / 20; // 近 20 日平均成交量（張）
    if (!(rise >= R.rise && back >= R.backMin && back <= R.backMax && days >= R.daysMin && days <= R.daysMax && C[L] > m20 && m20 > m20p && vol20 >= R.minVol && !/^00/.test(s.code))) continue; // 排除 ETF
    const w = C.slice(-N), sim = p.tpl.reduce((t, tp) => t + corr(w, tp), 0) / p.tpl.length;
    if (sim < R.minSim) continue;
    const vr = V.slice(lo, pk + 1).reduce((t, x) => t + x, 0) / (pk - lo + 1), vb = V.slice(pk + 1).reduce((t, x) => t + x, 0) / Math.max(1, days);
    const score = sim * 60 + Math.min(rise, 0.6) * 30 + (vb < vr ? 6 : 0) + (C[L] <= m5 * 1.01 ? 4 : 0);
    items.push({ code: s.code, name: s.name, mkt: s.mkt, ind: s.ind, d: b.at(-1)[0], c: C[L], rise: r1(rise * 100), back: r1(back * 100), days, sim: r2(sim), volDry: vb < vr, m20d: r1((C[L] / m20 - 1) * 100), amt: r2(amt), vol: Math.round(vol20), score: r1(score) });
  }
  items.sort((a, b) => b.score - a.score);
  out.patterns.push({ id: p.id, name: p.name, desc: p.desc, from: p.from, items: items.slice(0, 40) });
  console.log(`${p.name}：${items.length} 檔`, items.slice(0, 10).map(x => x.name).join('、'));
}
fs.writeFileSync('pm/similar.json', JSON.stringify(out));
