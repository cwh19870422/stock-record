// 個股三大法人買賣超（張）→ k/f/{代號}.json：{ d: [[日期, 外資, 投信, 自營商自行買賣, 自營商避險], ...] }
// 上市：證交所 T86；上櫃：櫃買中心三大法人日報。每次執行補最近缺的交易日（最多 INST_BACKFILL 天）
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record inst)' };
const BACK = +(process.env.INST_BACKFILL || 300);
const KEEP = 300;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => { const v = parseFloat(String(x ?? '').replace(/[,\s]/g, '')); return Number.isFinite(v) ? v : 0; };
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const log = [];
const say = s => { console.log(s); log.push(s); };
fs.mkdirSync('k/f', { recursive: true });

// 交易日：用台積電（上市）日K 的日期
const days = (readJSON('k/2330.json', { b: [] }).b || []).map(b => b[0]).slice(-KEEP);
const state = readJSON('k/f/_done.json', { twse: [], tpex: [] });
const done = { twse: new Set(state.twse), tpex: new Set(state.tpex) };

// 依欄位名稱找出 外資(含外資自營商)、投信、自營商自行買賣、自營商避險 的買賣超欄
function cols(fields) {
  const F = fields.map(f => String(f).replace(/<[^>]+>/g, '').replace(/\s/g, ''));
  const has = (f, ...w) => w.every(x => f.includes(x));
  const find = fn => F.findIndex(fn);
  const code = find(f => has(f, '代號'));
  let fi = [find(f => has(f, '外', '買賣超') && !f.includes('不含') && !f.includes('外資自營商'))];
  if (fi[0] < 0) fi = [find(f => has(f, '外', '買賣超', '不含')), find(f => has(f, '外資自營商', '買賣超') && !f.includes('不含'))];
  const it = find(f => has(f, '投信', '買賣超'));
  const dl = find(f => has(f, '自營商', '買賣超', '自行'));
  const dh = find(f => has(f, '自營商', '買賣超', '避險'));
  return { code, fi: fi.filter(i => i >= 0), it, dl, dh, F };
}
function parse(fields, rows, tag) {
  const c = cols(fields);
  if (c.code < 0 || !c.fi.length || c.it < 0) { say(`⚠️ ${tag} 欄位對不上：${c.F.join(',')}`); return null; }
  if (!parse[tag]) { parse[tag] = 1; say(`${tag} 欄位：外資=${c.fi.map(i => c.F[i]).join('+')}｜投信=${c.F[c.it]}｜自營=${c.F[c.dl]}｜避險=${c.F[c.dh]}`); }
  const m = new Map();
  const z = v => Math.round(v / 1000);
  rows.forEach(r => {
    const code = String(r[c.code]).trim();
    if (!/^\d{4}$|^00\d{2,4}[A-Z]?$/.test(code)) return;
    m.set(code, [z(c.fi.reduce((s, i) => s + num(r[i]), 0)), z(num(r[c.it])), c.dl >= 0 ? z(num(r[c.dl])) : 0, c.dh >= 0 ? z(num(r[c.dh])) : 0]);
  });
  return m;
}
async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  const t = await r.text();
  try { return JSON.parse(t); } catch { throw new Error('非 JSON（可能請求太頻繁）'); }
}
async function twse(d) {
  const j = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${d.replace(/-/g, '')}&selectType=ALLBUT0999&response=json`);
  if (j.stat !== 'OK') return /沒有符合|查無/.test(j.stat || '') ? new Map() : null;
  const t = j.fields ? j : (j.tables || []).find(t => t.fields && t.data);
  return t ? parse(t.fields, t.data || [], '上市') : null;
}
async function tpex(d) {
  try {
    const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${d.replace(/-/g, '/')}&response=json`);
    const t = (j.tables || []).find(t => t.fields && t.data);
    if (t) return t.data.length ? parse(t.fields, t.data, '上櫃') : new Map();
    if (j.stat && j.stat !== 'ok' && j.stat !== 'OK') say(`上櫃 ${d}：${j.stat}`);
  } catch (e) { say(`上櫃新網址 ${d}：${e.message}`); }
  // 舊網址備援：欄位固定位置
  const roc = `${+d.slice(0, 4) - 1911}/${d.slice(5, 7)}/${d.slice(8, 10)}`;
  const j = await getJSON(`https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d=${roc}`);
  const rows = j.aaData || j.tables?.[0]?.data;
  if (!rows) return null;
  if (!rows.length) return new Map();
  const z = v => Math.round(num(v) / 1000), m = new Map();
  rows.forEach(r => { const code = String(r[0]).trim(); if (/^\d{4}$|^00\d{2,4}[A-Z]?$/.test(code)) m.set(code, [z(r[10]), z(r[13]), z(r[16]), z(r[19])]); });
  if (!parse['上櫃舊']) { parse['上櫃舊'] = 1; say('上櫃：使用舊網址（固定欄位）'); }
  return m;
}

// 新到舊，缺哪天補哪天（最近 3 天每次都重抓，資料可能晚出）
const got = new Map(); // date -> Map(code -> row)
for (const [mk, fn] of [['twse', twse], ['tpex', tpex]]) {
  const todo = days.slice().reverse().filter((d, i) => i < 3 || !done[mk].has(d)).slice(0, BACK);
  let ok = 0, fail = 0;
  for (const d of todo) {
    let m = null;
    for (let k = 0; k < 3 && m == null; k++) {
      try { m = await fn(d); } catch (e) { if (k === 2) say(`⚠️ ${mk} ${d}：${e.message}`); }
      if (m == null) await sleep(6000 * (k + 1));
    }
    if (m == null) { fail++; if (fail >= 8) { say(`⚠️ ${mk} 連續失敗太多，先停`); break; } continue; }
    fail = 0;
    if (m.size) { const g = got.get(d) || new Map(); m.forEach((v, c) => g.set(c, v)); got.set(d, g); done[mk].add(d); ok++; }
    await sleep(mk === 'twse' ? 3200 : 1500);
  }
  say(`${mk === 'twse' ? '上市' : '上櫃'}法人：取得 ${ok} 天（待補 ${days.filter(d => !done[mk].has(d)).length} 天）`);
}

// 寫回每檔
const byCode = new Map();
for (const [d, m] of got) m.forEach((v, c) => { if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push([d, ...v]); });
let n = 0;
for (const [c, rows] of byCode) {
  const p = `k/f/${c}.json`, o = readJSON(p, { d: [] });
  const mm = new Map(o.d.map(r => [r[0], r]));
  rows.forEach(r => mm.set(r[0], r));
  o.d = [...mm.values()].sort((a, b) => a[0].localeCompare(b[0])).slice(-KEEP);
  fs.writeFileSync(p, JSON.stringify(o)); n++;
}
const keepSet = new Set(days);
fs.writeFileSync('k/f/_done.json', JSON.stringify({ twse: [...done.twse].filter(d => keepSet.has(d)).sort(), tpex: [...done.tpex].filter(d => keepSet.has(d)).sort() }));
say(`法人資料寫入 ${n} 檔`);
fs.writeFileSync('k/f/_log.txt', log.join('\n') + '\n');
