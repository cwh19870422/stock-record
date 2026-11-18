// 盤前看板：每天自動抓六大資料＋權值股前五，存到 pm/data.json
// 由 GitHub Actions 執行（.github/workflows/premarket.yml）
import fs from 'node:fs';

const FILE = 'pm/data.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record premarket)' };
const num = x => { const v = parseFloat(String(x ?? '').replace(/[,+\sX]/g, '')); return Number.isFinite(v) ? v : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const log = [];
const say = (...a) => { const s = a.join(' '); console.log(s); log.push(s); };

const taipeiNow = () => new Date(Date.now() + 8 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const rocToISO = s => { const [y, m, d] = String(s).trim().split('/'); return `${+y + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
const slashToISO = s => { const [y, m, d] = String(s).trim().split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
const compact = iso => iso.replace(/-/g, '');

let lastTwse = 0;
async function twse(url) { // 證交所有頻率限制，每次間隔 2.5 秒
  const wait = lastTwse + 2500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastTwse = Date.now();
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
async function taifexCSV(path, form) {
  const r = await fetch('https://www.taifex.com.tw/cht/3/' + path, {
    method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  const text = new TextDecoder('big5').decode(await r.arrayBuffer());
  const rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  if (!rows.length || rows[0].length < 5) throw new Error(`${path} 沒有資料：${text.slice(0, 80)}`);
  return rows;
}
const col = (header, ...keys) => header.findIndex(h => keys.every(k => h.includes(k)));

const old = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } })();
const D = {
  index: old.index || {}, inst: old.inst || {}, margin: old.margin || {}, fut: old.fut || {},
  night: old.night || {}, us: old.us || {}, top5: old.top5 || null,
};

// ---------- 1. 加權指數＋5均／月線＋成交金額 ----------
async function index() {
  const now = taipeiNow();
  const rows = [];
  for (let k = 2; k >= 0; k--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    const j = await twse(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${compact(ymd(m))}&response=json`);
    (j.data || []).forEach(r => rows.push({ d: rocToISO(r[0]), amt: num(r[2]), c: num(r[4]), ch: num(r[5]) }));
  }
  rows.sort((a, b) => a.d.localeCompare(b.d));
  rows.forEach((r, i) => {
    const avg = n => i + 1 >= n ? rows.slice(i + 1 - n, i + 1).reduce((s, x) => s + x.c, 0) / n : null;
    D.index[r.d] = { c: r.c, ch: r.ch, p: r2(r.ch / (r.c - r.ch) * 100), amt: r2(r.amt / 1e8), ma5: r2(avg(5)), ma20: r2(avg(20)) };
  });
  say(`指數：${rows.length} 天，最新 ${rows.at(-1)?.d} ${rows.at(-1)?.c}`);
  return rows.map(r => r.d);
}

// ---------- 2. 三大法人買賣超（億）----------
async function inst(days) {
  for (const d of days) {
    if (D.inst[d]) continue;
    const j = await twse(`https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${compact(d)}&response=json`);
    if (j.stat !== 'OK' || !j.data?.length) { say(`法人 ${d}：尚無資料`); continue; }
    const v = name => j.data.filter(r => r[0].includes(name)).reduce((s, r) => s + num(r[3]), 0) / 1e8;
    D.inst[d] = { fi: r2(v('外資')), it: r2(v('投信')), dl: r2(v('自營商') - v('外資自營商')), tot: r2(v('合計')) };
    say(`法人 ${d}：合計 ${D.inst[d].tot} 億`);
  }
}

// ---------- 3. 融資融券 ----------
async function margin(days) {
  for (const d of days) {
    if (D.margin[d]) continue;
    const j = await twse(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${compact(d)}&selectType=MS&response=json`);
    const t = j.tables?.find(t => t.data?.some(r => String(r[0]).includes('融資金額'))) || (j.creditList ? { data: j.creditList } : null);
    if (j.stat !== 'OK' || !t) { say(`融資券 ${d}：尚無資料`); continue; }
    const row = k => t.data.find(r => String(r[0]).includes(k));
    const amt = row('融資金額'), sh = row('融券');
    const bal = r => num(r.at(-1)), prev = r => num(r.at(-2));
    D.margin[d] = {
      fin: r2(bal(amt) / 1e5), finChg: r2((bal(amt) - prev(amt)) / 1e5),
      sht: bal(sh), shtChg: bal(sh) - prev(sh),
    };
    say(`融資券 ${d}：融資 ${D.margin[d].finChg} 億、融券 ${D.margin[d].shtChg} 張`);
  }
}

// ---------- 4. 外資台指期淨未平倉 ----------
async function futures() {
  const end = taipeiNow(), start = new Date(end - 40 * 864e5);
  const f = d => ymd(d).replace(/-/g, '/');
  const rows = await taifexCSV('futContractsDateDown', { queryStartDate: f(start), queryEndDate: f(end), commodityId: 'TXF' });
  const h = rows[0];
  const iD = col(h, '日期'), iWho = col(h, '身份'), iNet = col(h, '未平倉', '口數', '淨額');
  const list = rows.slice(1).filter(r => r[iWho]?.includes('外資')).map(r => ({ d: slashToISO(r[iD]), net: num(r[iNet]) }))
    .sort((a, b) => a.d.localeCompare(b.d));
  list.forEach((x, i) => { D.fut[x.d] = { net: x.net, chg: i ? x.net - list[i - 1].net : (D.fut[x.d]?.chg ?? null) }; });
  say(`期貨：${list.length} 天，最新 ${list.at(-1)?.d} 外資淨 ${list.at(-1)?.net}`);
}

// ---------- 5. 台指期夜盤（日期＝期交所歸屬的次一交易日）----------
async function night() {
  const end = taipeiNow(), start = new Date(end - 25 * 864e5);
  const f = d => ymd(d).replace(/-/g, '/');
  const rows = await taifexCSV('futDataDown', { down_type: '1', commodity_id: 'TX', queryStartDate: f(start), queryEndDate: f(end) });
  const h = rows[0];
  const iD = col(h, '日期'), iM = col(h, '到期'), iC = col(h, '收盤'), iCh = col(h, '漲跌價'), iP = col(h, '漲跌%'),
    iV = col(h, '成交量'), iS = col(h, '交易時段');
  const best = {};
  rows.slice(1).forEach(r => {
    if (!r[iS]?.includes('盤後') || !/^\d{6}$/.test(r[iM]) || num(r[iC]) == null) return;
    const d = slashToISO(r[iD]), v = num(r[iV]) || 0;
    if (!best[d] || v > best[d].v) best[d] = { v, c: num(r[iC]), ch: num(r[iCh]), p: num(r[iP]), m: r[iM] };
  });
  Object.entries(best).forEach(([d, x]) => { D.night[d] = { c: x.c, ch: x.ch, p: x.p, m: x.m }; });
  const last = Object.keys(best).sort().at(-1);
  say(`夜盤：${Object.keys(best).length} 天，最新 ${last} ${best[last]?.ch}`);
}

// ---------- 6. 美股（費半為主）----------
async function us() {
  for (const [key, sym] of [['SOX', '^SOX'], ['DJI', '^DJI'], ['IXIC', '^IXIC'], ['GSPC', '^GSPC']]) {
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1mo&interval=1d`);
      const res = j.chart.result[0], off = res.meta.gmtoffset || 0, cl = res.indicators.quote[0].close;
      const out = D.us[key] || {};
      let prev = null;
      res.timestamp.forEach((t, i) => {
        if (cl[i] == null) return;
        const d = ymd(new Date((t + off) * 1000));
        out[d] = { c: r2(cl[i]), p: prev ? r2((cl[i] / prev - 1) * 100) : (out[d]?.p ?? null) };
        prev = cl[i];
      });
      D.us[key] = out;
      say(`美股 ${key}：最新 ${Object.keys(out).sort().at(-1)}`);
    } catch (e) { say(`⚠️ 美股 ${key}：${e.message}`); }
  }
}

// ---------- 7. 權值股前五（依市值）----------
async function top5(days) {
  const [px, info] = await Promise.all([
    getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    getJSON('https://openapi.twse.com.tw/v1/opendata/t187ap03_L'),
  ]);
  const price = new Map(px.map(x => [x.Code, num(x.ClosingPrice)]));
  const caps = info.map(x => {
    const code = String(x['公司代號']).trim();
    const shares = num(x['已發行普通股數或TDR原股發行股數']);
    const p = price.get(code);
    return { code, name: String(x['公司簡稱']).trim(), cap: p && shares ? p * shares : 0 };
  }).filter(x => x.cap > 0);
  const total = caps.reduce((s, x) => s + x.cap, 0);
  caps.sort((a, b) => b.cap - a.cap);
  const prevList = new Map((D.top5?.list || []).map(x => [x.code, x]));
  const list = caps.slice(0, 5).map(x => ({ code: x.code, name: x.name, w: r2(x.cap / total * 100), hist: prevList.get(x.code)?.hist || {} }));

  // 每檔近兩個月收盤
  const now = taipeiNow();
  for (const s of list) {
    for (let k = 1; k >= 0; k--) {
      const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
      const j = await twse(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${compact(ymd(m))}&stockNo=${s.code}&response=json`);
      (j.data || []).forEach(r => {
        const d = rocToISO(r[0]), c = num(r[6]), ch = num(String(r[7]).replace('X', ''));
        s.hist[d] = { ...(s.hist[d] || {}), c, ch, p: c != null && ch != null ? r2(ch / (c - ch) * 100) : null };
      });
    }
  }
  // 每天外資買賣超（張）
  for (const d of days) {
    if (list.every(s => s.hist[d]?.fi != null)) continue;
    const j = await twse(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${compact(d)}&selectType=ALLBUT0999&response=json`);
    if (j.stat !== 'OK' || !j.data?.length) { say(`個股法人 ${d}：尚無資料`); continue; }
    const iFi = j.fields.findIndex(f => f.includes('外陸資買賣超股數') && !f.includes('自營商'));
    const iFi2 = iFi >= 0 ? iFi : j.fields.findIndex(f => f.includes('外資') && f.includes('買賣超'));
    list.forEach(s => {
      const r = j.data.find(r => String(r[0]).trim() === s.code);
      if (r) s.hist[d] = { ...(s.hist[d] || {}), fi: Math.round(num(r[iFi2]) / 1000) };
    });
  }
  list.forEach(s => { s.hist = Object.fromEntries(Object.entries(s.hist).sort().slice(-40)); });
  D.top5 = { asOf: [...days].at(-1), list };
  say(`權值股前五：${list.map(s => `${s.name}${s.w}%`).join('、')}`);
}

// ---------- 執行 ----------
let days = [];
const run = async (name, fn) => { try { await fn(); } catch (e) { say(`⚠️ ${name}失敗：${e.message}`); } };
await run('指數', async () => { days = (await index()).slice(-10); });
if (!days.length) days = Object.keys(D.index).sort().slice(-10);
await run('法人', () => inst(days));
await run('融資券', () => margin(days));
await run('期貨', futures);
await run('夜盤', night);
await run('美股', us);
await run('權值股', () => top5(days));

const trim = (o, n = 40) => Object.fromEntries(Object.entries(o).sort().slice(-n));
const out = {
  updated: taipeiNow().toISOString().slice(0, 16).replace('T', ' '),
  days,
  index: trim(D.index), inst: trim(D.inst), margin: trim(D.margin), fut: trim(D.fut), night: trim(D.night),
  us: Object.fromEntries(Object.entries(D.us).map(([k, v]) => [k, trim(v)])),
  top5: D.top5, log,
};
fs.mkdirSync('pm', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(out));
say('完成');
