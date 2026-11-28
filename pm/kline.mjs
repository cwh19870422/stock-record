// K線資料：加權指數、台指期夜盤、美股、權值股前五、自選股 → pm/kline.json
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record kline)' };
const num = x => { const v = parseFloat(String(x ?? '').replace(/[,\s]/g, '')); return Number.isFinite(v) ? v : null; };
const r2 = x => Math.round(x * 100) / 100;
const ymd = d => d.toISOString().slice(0, 10);
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const log = [];
const say = s => { console.log(s); log.push(s); };

async function yahoo(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3y&interval=1d`, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  const bars = [];
  res.timestamp.forEach((t, i) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(v => v == null)) return;
    bars.push([ymd(new Date((t + off) * 1000)), r2(q.open[i]), r2(q.high[i]), r2(q.low[i]), r2(q.close[i]), q.volume[i] || 0]);
  });
  // 同一天重複時保留最後一筆
  return [...new Map(bars.map(b => [b[0], b])).values()];
}

// 加權指數改用證交所官方開高低收（Yahoo 常晚一天、開高低也不準）；量＝成交金額（億）
// 已有官方資料時只補最近 2 個月；證交所偶爾回傳 HTML（太頻繁），就等久一點再換網址重試
async function twiiBars(prev) {
  const have = prev?.official ? prev.bars : [];
  const months = have.length > 700 ? 1 : 36; // 不足 3 年就把 36 個月補齊
  const now = new Date(Date.now() + 8 * 3600e3);
  const roc = s => { const [y, m, d] = String(s).trim().split('/'); return `${+y + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };
  const get = async paths => {
    for (let t = 0; t < 4; t++) {
      await new Promise(r => setTimeout(r, 3000 + t * 5000));
      try { const j = JSON.parse(await (await fetch('https://www.twse.com.tw' + paths[t % paths.length], { headers: UA })).text()); if (j.stat === 'OK') return j; } catch {}
    }
    throw new Error('證交所沒有回應 ' + paths[0]);
  };
  const m = new Map(have.map(b => [b[0], b]));
  for (let k = months; k >= 0; k--) {
    const ym = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))).replace(/-/g, '');
    let a, v;
    try {
      a = await get([`/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym}&response=json`, `/indicesReport/MI_5MINS_HIST?response=json&date=${ym}`]);
      v = await get([`/rwd/zh/afterTrading/FMTQIK?date=${ym}&response=json`, `/exchangeReport/FMTQIK?response=json&date=${ym}`]);
    } catch (e) { if (k === 0) throw e; say(`⚠️ 加權 ${ym}：${e.message}（下次再補）`); continue; } // 舊月份失敗就跳過，下次再補
    const amt = new Map((v.data || []).map(r => [roc(r[0]), Math.round(num(r[2]) / 1e8)]));
    (a.data || []).forEach(r => { const d = roc(r[0]), bar = [d, num(r[1]), num(r[2]), num(r[3]), num(r[4]), amt.get(d) || 0]; if (bar.slice(1, 5).every(x => x != null)) m.set(d, bar); });
  }
  return [...m.values()].sort((x, y) => x[0].localeCompare(y[0])).slice(-800);
}
// 夜盤：沿用舊資料，不足 3 年時一次往回補 3 年（每段 28 天），之後只抓最近 2 段
async function nightBars(prev) {
  const out = Object.fromEntries((prev?.bars || []).map(b => [b[0], b]));
  const segs = (prev?.bars?.length || 0) > 600 ? 1 : 39;
  const now = new Date(Date.now() + 8 * 3600e3);
  for (let k = segs; k >= 0; k--) {
    const end = new Date(now - k * 28 * 864e5), start = new Date(end - 27 * 864e5);
    const f = d => ymd(d).replace(/-/g, '/');
    const r = await fetch('https://www.taifex.com.tw/cht/3/futDataDown', {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ down_type: '1', commodity_id: 'TX', queryStartDate: f(start), queryEndDate: f(end) }).toString(),
    });
    const rows = new TextDecoder('big5').decode(await r.arrayBuffer()).split(/\r?\n/).filter(Boolean).map(l => l.split(',').map(c => c.trim()));
    const h = rows[0] || [], col = (...ks) => h.findIndex(x => ks.every(s => x.includes(s)));
    const iD = col('日期'), iM = col('到期'), iO = col('開盤'), iH = col('最高'), iL = col('最低'), iC = col('收盤'), iV = col('成交量'), iS = col('交易時段');
    rows.slice(1).forEach(x => {
      if (!x[iS]?.includes('盤後') || !/^\d{6}$/.test(x[iM]) || num(x[iC]) == null) return;
      const d = x[iD].replace(/\//g, '-'), v = num(x[iV]) || 0;
      if (!out[d] || v > out[d][5]) out[d] = [d, num(x[iO]), num(x[iH]), num(x[iL]), num(x[iC]), v];
    });
    await new Promise(r => setTimeout(r, 1500));
  }
  return Object.values(out).sort((a, b) => a[0].localeCompare(b[0])).slice(-800);
}

const data = readJSON('pm/data.json', {});
const watch = readJSON('pm/watch.json', []);
const list = [
  ['TWII', '加權指數', '^TWII', 'idx'],
  ['TXN', '台指期夜盤', null, 'night'],
  ['SOX', '費城半導體', '^SOX', 'us'],
  ['DJI', '道瓊', '^DJI', 'us'],
  ['IXIC', '那斯達克', '^IXIC', 'us'],
  ['GSPC', 'S&P 500', '^GSPC', 'us'],
  ...(data.top5?.list || []).map(s => [s.code, s.name, `${s.code}.TW`, 'top5']),
  ...watch.map(s => [s.code, s.name || s.code, s.yahoo || `${s.code}.TW`, 'watch']),
];
const old = readJSON('pm/kline.json', { items: [] });
const items = [];
for (const [id, name, sym, group] of list) {
  if (items.some(x => x.id === id)) continue;
  try {
    let bars, official = false;
    if (id === 'TWII') {
      bars = await twiiBars(old.items.find(x => x.id === 'TWII')).catch(e => { say('⚠️ 加權官方資料：' + e.message); return []; });
      official = bars.length >= 100;
      if (!official) { const keep = old.items.find(x => x.id === 'TWII' && x.official); bars = keep ? keep.bars : await yahoo(sym); official = !!keep; }
    } else bars = sym ? await yahoo(sym) : await nightBars(old.items.find(x => x.id === 'TXN'));
    if (!bars.length) throw new Error('沒有資料');
    items.push({ id, name, group, bars, ...(official ? { official: true } : {}) });
    say(`${name}：${bars.length} 根，最新 ${bars.at(-1)[0]} 收 ${bars.at(-1)[4]}`);
  } catch (e) {
    const keep = old.items.find(x => x.id === id);
    if (keep) items.push(keep);
    say(`⚠️ ${name}：${e.message}${keep ? '（沿用舊資料）' : ''}`);
  }
}
fs.writeFileSync('pm/kline.json', JSON.stringify({ updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), items, log }));
