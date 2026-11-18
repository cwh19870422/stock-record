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
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`, { headers: UA });
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

async function nightBars() {
  const out = {};
  const now = new Date(Date.now() + 8 * 3600e3);
  for (let k = 4; k >= 0; k--) {
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
  return Object.values(out).sort((a, b) => a[0].localeCompare(b[0]));
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
    const bars = sym ? await yahoo(sym) : await nightBars();
    if (!bars.length) throw new Error('沒有資料');
    items.push({ id, name, group, bars });
    say(`${name}：${bars.length} 根，最新 ${bars.at(-1)[0]} 收 ${bars.at(-1)[4]}`);
  } catch (e) {
    const keep = old.items.find(x => x.id === id);
    if (keep) items.push(keep);
    say(`⚠️ ${name}：${e.message}${keep ? '（沿用舊資料）' : ''}`);
  }
}
fs.writeFileSync('pm/kline.json', JSON.stringify({ updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), items, log }));
