// 全部個股 K 線資料庫：k/{代號}.json（近 300 根日K）＋ k/list.json（搜尋清單）
// 每天收盤後：證交所 MI_INDEX（上市）＋櫃買 OpenAPI（上櫃）補上當天一根；沒有歷史的股票用 Yahoo 補一年
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record stocks)' };
const MAX_BACKFILL = +(process.env.MAX_BACKFILL || 3000);
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
      globalThis.IDX_TABLES = j.tables;
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

// ---------- 產業熱力圖資料 → pm/sector.json ----------
const IND = { '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械', '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業', '12': '汽車工業', '14': '建材營造', '15': '航運業', '16': '觀光餐旅', '17': '金融保險', '18': '貿易百貨', '19': '綜合', '20': '其他', '21': '化學工業', '22': '生技醫療', '23': '油電燃氣', '24': '半導體業', '25': '電腦週邊', '26': '光電業', '27': '通信網路', '28': '電子零組件', '29': '電子通路', '30': '資訊服務', '31': '其他電子', '32': '文化創意', '33': '農業科技', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒', '38': '居家生活' };
async function info(url) {
  try { const r = await fetch(url, { headers: UA }); return await r.json(); } catch (e) { say('⚠️ 公司資料：' + e.message); return []; }
}
const pick = (o, ...keys) => { for (const k of Object.keys(o)) if (keys.some(x => k.includes(x))) return o[k]; return null; };
const meta = new Map();
for (const [url, m] of [['https://openapi.twse.com.tw/v1/opendata/t187ap03_L', '上市'], ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', '上櫃']]) {
  const arr = await info(url);
  if (arr[0]) say(`${m}公司資料欄位：${Object.keys(arr[0]).join(',').slice(0, 300)}`);
  arr.forEach(x => {
    const c = String(pick(x, '公司代號', 'SecuritiesCompanyCode') ?? '').trim();
    const ind = String(pick(x, '產業別', 'SecuritiesIndustryCode', 'IndustryCode') ?? '').trim().padStart(2, '0');
    const sh = num(pick(x, '已發行普通股數', 'IssueShares', 'Shares'));
    if (c) meta.set(c, { m, ind: IND[ind] || null, sh });
  });
}
// 搜尋清單補上產業別：[代號, 名稱, 上市/上櫃, 產業]
list.forEach(x => { x[3] = meta.get(x[0])?.ind || x[3] || ''; });
fs.writeFileSync('k/list.json', JSON.stringify(list));
// 每檔最新收盤與漲跌幅（新聞標籤用）→ k/last.json
const last = {};
for (const [c] of list) { const o = read(c); if (o?.b?.length >= 2) { const a = o.b.at(-1), b = o.b.at(-2); last[c] = [a[4], r2((a[4] / b[4] - 1) * 100)]; } }
fs.writeFileSync('k/last.json', JSON.stringify(last));
const PER = { d: 1, w: 5, m: 20, q: 60, y: 240 };
const agg = {};
for (const [c, nm, mk] of list) {
  const me = meta.get(c); if (!me?.ind) continue;
  const o = read(c); if (!o || o.b.length < 2) continue;
  const b = o.b, last = b.at(-1), cap = (me.sh || 0) * last[4];
  const A = (agg[mk] ||= {});
  for (const [p, nDays] of Object.entries(PER)) {
    if (b.length <= nDays) continue;
    const base = b[b.length - 1 - nDays][4], pct = (last[4] / base - 1) * 100;
    const val = b.slice(-nDays).reduce((s, r) => s + r[4] * r[5] * 1000, 0) / 1e8;
    const g = ((A[p] ||= {})[me.ind] ||= { name: me.ind, val: 0, cap: 0, wp: 0, n: 0, st: [] });
    g.val += val; g.cap += cap; g.wp += cap * pct; g.n++;
    g.st.push([c, nm, r2(val), r2(pct)]);
  }
}
const sector = { asOf: today.find(x => x.m === '上市')?.bar[0] || null, markets: {} };
for (const [mk, A] of Object.entries(agg)) {
  sector.markets[mk] = {};
  for (const [p, G] of Object.entries(A)) {
    sector.markets[mk][p] = Object.values(G).map(g => ({
      name: g.name, val: Math.round(g.val), pct: r2(g.cap ? g.wp / g.cap : 0), n: g.n,
      top: g.st.sort((a, b) => b[2] - a[2]).slice(0, 20).map(x => [x[0], x[1], Math.round(x[2] * 10) / 10, x[3]]),
    })).filter(g => g.val > 0).sort((a, b) => b.val - a.val);
  }
}
// 上市「日」漲跌幅改用證交所官方類股指數
try {
const norm = n => String(n).replace(/類指數|指數|工業|業|設備|及|\s/g, '');
const off = new Map();
(globalThis.IDX_TABLES || []).forEach(t => {
  if (!Array.isArray(t?.fields) || !Array.isArray(t?.data)) return;
  const iN = t.fields.findIndex(f => String(f).includes('指數')), iP = t.fields.findIndex(f => String(f).includes('百分比'));
  if (iN < 0 || iP < 0) return;
  t.data.forEach(r => { const nm = String(r[iN]); if (nm.includes('類指數')) off.set(norm(nm), num(String(r[iP]).replace(/<[^>]+>/g, ''))); });
});
(sector.markets['上市']?.d || []).forEach(g => {
  const v = off.get(norm(g.name));
  if (v != null) { log.push(`  ${g.name}：自算 ${g.pct}% → 官方 ${v}%`); g.pct = v; g.official = true; }
});
say(`官方類股指數對到 ${(sector.markets['上市']?.d || []).filter(g => g.official).length} 類`);
} catch (e) { say('⚠️ 官方類股指數：' + e.message); }
fs.writeFileSync('pm/sector.json', JSON.stringify(sector));
say(`產業熱力圖：${Object.entries(sector.markets).map(([m, x]) => `${m} ${x.d?.length || 0} 類`).join('、')}`);
fs.writeFileSync('k/log.txt', log.join('\n') + '\n');
