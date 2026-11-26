// 每日自動更新：股票清單、收盤價、加權指數、交易當日新聞
// 由 GitHub Actions 執行（.github/workflows/daily-update.yml）
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record daily update)' };
const num = x => parseFloat(String(x ?? '').replace(/,/g, '').trim());
const roc = s => { s = String(s); const y = +s.slice(0, s.length - 4) + 1911; return `${y}-${s.slice(-4, -2)}-${s.slice(-2)}`; };
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJSON = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
async function getJSON(u) {
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error(`${u} → HTTP ${r.status}`);
  return r.json();
}
// 只留證券 App 可下單的一般標的（排除權證）
const keep = c => /^\d{4}$/.test(c) || /^\d{4}[A-Z]$/.test(c) || /^00\d{2,4}[A-Z]?$/.test(c) || /^02\d{4}$/.test(c) || /^91\d{4}$/.test(c);
const typeOf = c => /^02\d{4}$/.test(c) ? 'N' : /^00/.test(c) ? (/B$/.test(c) ? 'B' : 'E') : 'S';

const taipeiNow = () => new Date(Date.now() + 8 * 3600e3);
const today = taipeiNow().toISOString().slice(0, 10);

// ---------- 1. 股票清單 + 收盤價 ----------
async function updateStocks() {
  const old = readJSON('data/stocks.json', []);
  const map = new Map(old.map(s => [s[0], s]));
  const prices = readJSON('data/prices.json', { date: '', p: {} });
  const p = {};
  let date = '';
  const add = (code, name, m, close, d) => {
    code = String(code || '').trim(); name = String(name || '').trim();
    if (!keep(code) || !name) return;
    map.set(code, [code, name, typeOf(code), m]);
    const c = num(close);
    if (c > 0) p[code] = c;
    if (d && roc(d) > date) date = roc(d);
  };
  const results = await Promise.allSettled([
    getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'),
    getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'),
    getJSON('https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics'),
  ]);
  const [twse, tpex, esb] = results.map(r => r.status === 'fulfilled' ? r.value : (console.log('⚠️', r.reason.message), null));
  twse?.forEach(x => add(x.Code, x.Name, '市', x.ClosingPrice, x.Date));
  tpex?.forEach(x => add(x.SecuritiesCompanyCode, x.CompanyName, '櫃', x.Close, x.Date));
  esb?.forEach(x => add(x.SecuritiesCompanyCode, x.CompanyName, '興', x.LatestPrice, x.Date));
  const list = [...map.values()].sort((a, b) => a[0].localeCompare(b[0]));
  writeJSON('data/stocks.json', list);
  if (Object.keys(p).length) writeJSON('data/prices.json', { date, p: { ...prices.p, ...p } });
  console.log(`股票清單 ${list.length} 檔，收盤價 ${Object.keys(p).length} 筆（${date}）`);
}

// ---------- 2. 加權指數 ----------
async function updateMarket() {
  const mk = readJSON('data/market.json', {});
  const a = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX');
  const t = a.find(x => x['指數'] === '發行量加權股價指數');
  if (!t) return console.log('⚠️ 找不到加權指數');
  const s = t['漲跌'] === '-' ? -1 : 1;
  const d = roc(t['日期']);
  mk[d] = { c: num(t['收盤指數']), ch: +(s * num(t['漲跌點數'])).toFixed(2), p: +(s * num(t['漲跌百分比'])).toFixed(2) };
  writeJSON('data/market.json', mk);
  console.log(`加權指數 ${d}：${mk[d].c}（${mk[d].ch}）`);
}

// ---------- 2b. 補齊過去的加權指數（從 2024 年起，每月一次）----------
async function backfillMarket() {
  const mk = readJSON('data/market.json', {});
  const now = taipeiNow(), cur = now.toISOString().slice(0, 7);
  let n = 0;
  for (let y = 2024; y <= now.getUTCFullYear(); y++) for (let m = 1; m <= 12; m++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > cur) break;
    const have = Object.keys(mk).filter(k => k.startsWith(ym)).length;
    if (ym < cur && have >= 15) continue;
    try {
      const j = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ym.replace('-', '')}01&response=json`);
      (j.data || []).forEach(r => {
        const [yy, mm, dd] = r[0].split('/');
        const d = `${+yy + 1911}-${mm}-${dd}`, c = num(r[4]), ch = num(r[5]);
        mk[d] = { c, ch, p: +(ch / (c - ch) * 100).toFixed(2) };
      });
      n++;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) { console.log('⚠️ 補大盤', ym, e.message); }
  }
  const sorted = Object.fromEntries(Object.entries(mk).sort(([a], [b]) => a.localeCompare(b)));
  writeJSON('data/market.json', sorted);
  console.log(`補大盤：抓了 ${n} 個月，共 ${Object.keys(sorted).length} 天`);
}

// ---------- 3. 交易當日新聞（寫回 Firebase）----------
async function news(q, date, n) {
  const next = new Date(Date.parse(date) + 864e5).toISOString().slice(0, 10);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} after:${date} before:${next}`)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('news HTTP ' + r.status);
  const xml = await r.text();
  const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const seen = new Set();
  return xml.split('<item>').slice(1).map(it => {
    const g = t => dec((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
    const src = g('source');
    let t = g('title'); if (src && t.endsWith(' - ' + src)) t = t.slice(0, -(src.length + 3));
    return { t, u: g('link'), s: src };
  }).filter(x => x.t && !seen.has(x.t) && seen.add(x.t)).slice(0, n);
}


// ---------- 3b. 交易當日走勢（分鐘資料，寫回 Firebase）----------
// 格式：{y:昨收, t:[距 09:00 分鐘數], p:[價格]}；抓不到時存 {e:1}
const tpe = (date, hm) => Date.parse(`${date}T${hm}:00+08:00`) / 1000;
async function ticksYahoo(sym, date) {
  for (const iv of ['1m', '2m', '5m']) {
    try {
      const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&period1=${tpe(date, '08:59')}&period2=${tpe(date, '13:40')}&includePrePost=false`);
      const r = j.chart?.result?.[0], ts = r?.timestamp || [], cl = r?.indicators?.quote?.[0]?.close || [];
      const t = [], p = [];
      ts.forEach((x, i) => { const m = Math.round((x - tpe(date, '09:00')) / 60); if (cl[i] != null && m >= 0 && m <= 275) { t.push(m); p.push(+cl[i].toFixed(2)); } });
      if (p.length > 5) return { y: r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? null, t, p, iv };
    } catch (e) { console.log('⚠️ 走勢', sym, date, iv, e.message); }
  }
  return null;
}
async function ticksIndex(date) {
  try { // 證交所每 5 秒加權指數，取每分鐘一點
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX?date=${date.replace(/-/g, '')}&response=json`);
    const t = [], p = [];
    (j.data || []).forEach(r => { const [h, m, sec] = String(r[0]).split(':').map(Number); if (sec !== 0) return; const v = num(r[1]); if (v > 0) { t.push((h - 9) * 60 + m); p.push(v); } });
    if (p.length > 5) {
      const mk = readJSON('data/market.json', {}), prev = Object.keys(mk).filter(k => k < date).sort().pop();
      return { y: prev ? mk[prev].c : null, t, p, iv: '1m' };
    }
  } catch (e) { console.log('⚠️ 大盤走勢', date, e.message); }
  return ticksYahoo('^TWII', date);
}

async function updateNews() {
  const cfg = readJSON('config.json', {});
  const key = cfg.firebase?.apiKey, pid = cfg.firebase?.projectId, email = cfg.botEmail, pw = process.env.BOT_PASSWORD;
  if (!key || !pid || !email || !pw) return console.log('ℹ️ 尚未設定 Firebase／機器人帳號，略過新聞');
  const login = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw, returnSecureToken: true }),
  }).then(r => r.json());
  if (!login.idToken) return console.log('⚠️ 機器人登入失敗', login.error?.message);
  const H = { Authorization: 'Bearer ' + login.idToken, 'Content-Type': 'application/json' };
  const base = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
  const q = await fetch(`${base}/queue?pageSize=300`, { headers: H }).then(r => r.json());
  const docs = q.documents || [];
  const hour = taipeiNow().getUTCHours();
  const put = (id, items, date) => fetch(`${base}/auto/${id}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(items) }, date: { stringValue: date } } }),
  });
  const MKTOF = new Map(readJSON('data/stocks.json', []).map(x => [x[0], x[3]]));
  const exists = async id => (await fetch(`${base}/auto/${id}`, { headers: H })).ok;
  let n = 0;
  for (const d of docs) {
    const f = d.fields || {}, code = f.code?.stringValue, name = f.name?.stringValue, date = f.date?.stringValue;
    if (!code || !date) continue;
    if (date > today || (date === today && hour < 16)) continue; // 當天等收盤後再抓
    try {
      if (!(await exists(`news_${date}_${code}`))) await put(`news_${date}_${code}`, await news(name || code, date, 5), date);
      if (!(await exists(`news_${date}_MKT`))) await put(`news_${date}_MKT`, await news('台股 大盤', date, 3), date);
      await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: 'DELETE', headers: H });
      n++;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) { console.log('⚠️ 新聞', code, date, e.message); }
  }
  console.log(`新聞：處理 ${n} 筆，佇列共 ${docs.length} 筆`);
}

// 走勢資料來源自我檢查（只印紀錄）
async function probeTicks() {
  const mk = readJSON('data/market.json', {}), d = Object.keys(mk).sort().pop();
  if (!d) return;
  const a = await ticksYahoo('2330.TW', d), b = await ticksIndex(d);
  console.log(`走勢來源檢查 ${d}：個股 ${a ? a.p.length + ' 點（' + a.iv + '）' : '失敗'}，大盤 ${b ? b.p.length + ' 點' : '失敗'}`);
}
fs.mkdirSync('data', { recursive: true });
for (const [name, fn] of [['股票', updateStocks], ['大盤', updateMarket], ['補大盤', backfillMarket],['新聞', updateNews]]) {
  try { await fn(); } catch (e) { console.log(`⚠️ ${name}更新失敗：`, e.message); }
}
