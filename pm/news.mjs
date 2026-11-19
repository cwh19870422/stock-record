// 直接到三家媒體網站抓最新新聞列表 → pm/news.json（台股 tw、國際 intl）
//  中央社：官方新聞列表 API（證券 asc、產經 aie、國際 aopl）
//  經濟日報：即時新聞列表頁（證券 5590、國際 5588）
//  時報新聞：工商時報即時證券列表頁
// 鉅亨網、重大訊息、PTT 由 Cloudflare 轉接站即時抓
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'zh-TW,zh;q=0.9' };
const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').trim();
const tp = s => Date.parse(String(s).trim().replace(/[./]/g, '-').replace(' ', 'T') + ':00+08:00') || 0; // 台北時間字串 → 毫秒
const ECON = /美股|聯準會|Fed|美債|殖利率|油價|關稅|經濟|通膨|利率|股市|晶片|半導體|輝達|美元|日圓|央行|貿易|出口|財報|降息|升息|歐股|陸股|日股|韓股|黃金|比特幣|AI/;
const log = [];

async function get(url, opt = {}) {
  for (let t = 0; t < 3; t++) {
    try { const r = await fetch(url, { ...opt, headers: { ...UA, ...(opt.headers || {}) } }); if (r.ok) return r; log.push(`  ${url.slice(0, 60)} → HTTP ${r.status}`); } catch (e) { log.push(`  ${url.slice(0, 60)} → ${e.message}`); }
    await new Promise(r => setTimeout(r, 3000 + t * 4000));
  }
  throw new Error('抓不到');
}

// 中央社
async function cna(cat) {
  const r = await get('https://www.cna.com.tw/cna2018api/api/WNewsList', { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://www.cna.com.tw/list/aie.aspx', Origin: 'https://www.cna.com.tw' }, body: JSON.stringify({ action: '0', category: cat, pagesize: '30', pageidx: 1 }) });
  const j = await r.json();
  return (j.ResultData?.Items || []).map(x => ({ t: dec(x.HeadLine), u: x.PageUrl, s: '中央社', at: tp(x.CreateTime), st: [] }));
}
// 經濟日報
async function udn(cate) {
  const html = await (await get(`https://money.udn.com/rank/newest/1001/${cate}/1`)).text();
  return html.split('<li class="story-headline-wrapper">').slice(1).map(b => {
    const a = b.match(/href="(https:\/\/money\.udn\.com\/money\/story\/\d+\/\d+)[^"]*"[^>]*title="([^"]+)"/);
    const tm = (b.match(/<time>([^<]+)<\/time>/) || [])[1];
    return a ? { t: dec(a[2]), u: a[1], s: '經濟日報', at: tp(tm), st: [] } : null;
  }).filter(Boolean);
}
// 時報新聞（工商時報）：先抓 RSS，不行再抓列表頁
async function ctee(path) {
  try {
    const x = await (await get(`https://www.ctee.com.tw/rss_web/livenews/${path}`, { headers: { Accept: 'application/rss+xml,text/xml,*/*' } })).text();
    const r = x.split('<item>').slice(1).map(b => {
      const g = k => dec(((b.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, ''));
      return { t: g('title'), u: g('link').replace(/\?.*/, ''), s: '時報新聞', at: tp(g('pubDate').slice(0, 16)), st: [] };
    }).filter(x => x.t && x.u);
    if (r.length) return r;
  } catch {}
  const html = await (await get(`https://www.ctee.com.tw/livenews/${path}`)).text();
  return html.split('<div class="newslist__card">').slice(1).map(b => {
    const a = b.match(/<h3 class="news-title"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const d = (b.match(/<time class="news-date">([^<]+)<\/time>/) || [])[1], t = (b.match(/<time class="news-time">([^<]+)<\/time>/) || [])[1];
    return a ? { t: dec(a[2]), u: new URL(a[1].replace(/\?.*/, ''), 'https://www.ctee.com.tw').href, s: '時報新聞', at: d && t ? tp(`${d} ${t}`) : 0, st: [] } : null;
  }).filter(Boolean);
}

const JOBS = {
  tw: [['中央社 證券', () => cna('asc')], ['中央社 產經', () => cna('aie')], ['經濟日報 證券', () => udn(5590)], ['時報新聞 證券', () => ctee('stock')]],
  intl: [['中央社 國際', async () => (await cna('aopl')).filter(x => ECON.test(x.t))], ['經濟日報 國際', async () => (await udn(5588)).filter(x => ECON.test(x.t))]],
};
const old = (() => { try { return JSON.parse(fs.readFileSync('pm/news.json', 'utf8')); } catch { return {}; } })();
const out = { updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') };
for (const [k, jobs] of Object.entries(JOBS)) {
  const all = [];
  for (const [name, fn] of jobs) {
    try { const r = await fn(); all.push(...r); log.push(`${name}：${r.length} 則`); }
    catch (e) { log.push(`⚠️ ${name}：${e.message}`); (old[k] || []).filter(x => name.startsWith(x.s)).forEach(x => all.push(x)); }
  }
  const seen = new Set();
  out[k] = all.filter(x => x.t && x.u).sort((a, b) => b.at - a.at)
    .filter(x => { const key = x.t.replace(/\s|《[^》]*》|〈[^〉]*〉/g, '').slice(0, 16); return !seen.has(key) && seen.add(key); }).slice(0, 80);
}
out.log = log;
console.log(log.join('\n'));
fs.writeFileSync('pm/news.json', JSON.stringify(out));
