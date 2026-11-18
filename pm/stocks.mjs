// 全部個股 K 線資料庫：k/{代號}.json（近 300 根日K）＋ k/list.json（搜尋清單）
// 每天收盤後：證交所 MI_INDEX（上市）＋櫃買 OpenAPI（上櫃）補上當天一根；沒有歷史的股票用 Yahoo 補一年
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record stocks)' };
const MAX_BACKFILL = +(process.env.MAX_BACKFILL || 1300);
const KEEP = 300;
const num = x => { const v = parseFloat(String(x ?? '').replace(/[,\s]/g, '')); return Number.isFinite(v) ? v : null; };
const r2 = x => Math.round(x * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10);
const okCode = c => /^\d{4}$/.test(c) || /^00\d{2,4}[A-Z]?$/.test(c);
fs.mkdirSync('k', { recursive: true });
const log = [];
const say = s => { console.log(s); log.push(s); };
const read = c => { try { return JSON.parse(fs.readFileSync(`k/${c}.json`, 'utf8')); } catch { return null; } };
const write = o => fs.writeFileSync(`k/${o.c}.json`, JSON.stringify(o));

// ---------- 1. 當天全部行情 ----------
async function twseDay() { // 往回找最近一個有資料的交易日
  for (let k = 0; k < 7; k++) {
    const d = ymd(new Date(Date.now() + 8 * 3600e3 - k * 864e5));
    const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d.replace(/-/g, '')}&type=ALLBUT0999&response=json`, { headers: UA });
    const j = await r.json().catch(() => ({}));
    const t = (j.tables || []).find(t => t.fields?.includes('證券代號') && t.fields?.includes('收盤價'));
    if (j.stat === 'OK' && t?.data?.length) {
      const f = n => t.fields.indexOf(n);
      const [iC, iN, iV, iO, iH, iL, iX] = ['證券代號', '證券名稱', '成交股數', '開盤價', '最高價', '最低價', '收盤價'].map(f);
      const rows = t.data.map(r => ({ c: String(r[iC]).trim(), n: String(r[iN]).trim(), m: '上市', bar: [d, num(r[iO]), num(r[iH]), num(r[iL]), num(r[iX]), Math.round((num(r[iV]) || 0) / 1000)] }))
        .filter(x => okCode(x.c));
      say(`上市 ${d}：${rows.length} 檔`);
      return rows;
    }
    await sleep(2500);
  }
  say('⚠️ 上市行情：找不到資料'); return [];
}
async function tpexDay() {
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { headers: UA });
    const j = await r.json();
    const rows = j.map(x => {
      const ds = String(x.Date || ''), d = ds.length === 7 ? `${+ds.slice(0, 3) + 1911}-${ds.slice(3, 5)}-${ds.slice(5, 7)}` : null;
      return { c: String(x.SecuritiesCompanyCode).trim(), n: String(x.CompanyName).trim(), m: '上櫃', bar: [d, num(x.Open), num(x.High), num(x.Low), num(x.Close), Math.round((num(x.TradingShares) || 0) / 1000)] };
    }).filter(x => okCode(x.c) && x.bar[0]);
    say(`上櫃 ${rows[0]?.bar[0]}：${rows.length} 檔`);
    return rows;
  } catch (e) { say('⚠️ 上櫃行情：' + e.message); return []; }
}

// ---------- 2. Yahoo 補一年歷史 ----------
async function yahoo(code, market) {
  const sym = `${code}.${market === '上櫃' ? 'TWO' : 'TW'}`;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=15mo&interval=1d`, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result?.[0];
  if (!res?.timestamp) throw new Error('沒有資料');
  const q = res.indicators.quote[0], off = res.meta.gmtoffset || 28800;
  const m = new Map();
  res.timestamp.forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
    const d = ymd(new Date((t + off) * 1000));
    m.set(d, [d, r2(q.open[i]), r2(q.high[i]), r2(q.low[i]), r2(q.close[i]), Math.round((q.volume[i] || 0) / 1000)]);
  });
  return [...m.values()];
}

// ---------- 執行 ----------
const today = [...await twseDay(), ...await tpexDay()];
const listOld = (() => { try { return JSON.parse(fs.readFileSync('k/list.json', 'utf8')); } catch { return []; } })();
const names = new Map(listOld.map(x => [x[0], x]));
today.forEach(x => names.set(x.c, [x.c, x.n, x.m]));

let appended = 0, filled = 0, failed = 0;
const need = [];
for (const x of today) {
  const o = read(x.c);
  const valid = x.bar.slice(1, 5).every(v => v != null && v > 0);
  if (!o) { need.push(x); continue; }
  if (!valid) continue;
  const last = o.b.at(-1)?.[0];
  if (last === x.bar[0]) { if (JSON.stringify(o.b.at(-1)) === JSON.stringify(x.bar)) continue; o.b[o.b.length - 1] = x.bar; }
  else if (!last || last < x.bar[0]) o.b.push(x.bar);
  else continue;
  o.n = x.n; o.b = o.b.slice(-KEEP); write(o); appended++;
}
// 沒有歷史的股票 → Yahoo 補（每次最多 MAX_BACKFILL 檔，5 檔同時）
const queue = need.slice(0, MAX_BACKFILL);
async function worker() {
  while (queue.length) {
    const x = queue.shift();
    try {
      let b = await yahoo(x.c, x.m);
      const valid = x.bar.slice(1, 5).every(v => v != null && v > 0);
      if (valid) { b = b.filter(r => r[0] !== x.bar[0]); b.push(x.bar); b.sort((a, c) => a[0].localeCompare(c[0])); }
      if (b.length) { write({ c: x.c, n: x.n, m: x.m, b: b.slice(-KEEP) }); filled++; } else failed++;
    } catch { failed++; }
    await sleep(150);
  }
}
await Promise.all(Array.from({ length: 5 }, worker));
const list = [...names.values()].filter(x => fs.existsSync(`k/${x[0]}.json`)).sort((a, b) => a[0].localeCompare(b[0]));
fs.writeFileSync('k/list.json', JSON.stringify(list));
say(`新增當日K：${appended} 檔｜補歷史：${filled} 檔（失敗 ${failed}，尚待補 ${Math.max(0, need.length - MAX_BACKFILL)}）｜清單共 ${list.length} 檔`);
fs.writeFileSync('k/log.txt', log.join('\n') + '\n');
