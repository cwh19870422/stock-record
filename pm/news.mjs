// 時報新聞、經濟日報、中央社（透過 Google 新聞 RSS，近 1 天）→ pm/news.json
// 鉅亨網、重大訊息、PTT 由 Cloudflare 轉接站即時抓；這三家 Google 會擋轉接站，所以改由這裡每 30 分鐘抓一次
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record news)' };
const SITES = '(site:ctee.com.tw OR site:money.udn.com OR site:cna.com.tw)';
const Q = {
  tw: [`(台股 OR 股市 OR 個股 OR 法人) ${SITES}`, `(上市 OR 上櫃 OR 營收 OR 外資 OR 投信) ${SITES}`, `(類股 OR 族群 OR 漲停 OR 法說) ${SITES}`],
  intl: [`(美股 OR 聯準會 OR Fed OR 美債 OR 道瓊 OR 費半) ${SITES}`, `(油價 OR 美元 OR 日圓 OR 關稅 OR 輝達 OR 歐股 OR 陸股) ${SITES}`],
};
const dec = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
const srcName = s => /工商|時報|ctee/i.test(s) ? '時報新聞' : /經濟日報|udn/i.test(s) ? '經濟日報' : /中央社|cna/i.test(s) ? '中央社' : s;

async function rss(q) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.text()).split('<item>').slice(1).map(it => {
    const g = t => dec((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1]);
    const s = g('source'); let t = g('title'); if (s && t.endsWith(' - ' + s)) t = t.slice(0, -(s.length + 3));
    return { t, u: g('link'), s: srcName(s), at: Date.parse(g('pubDate')) || 0, st: [] };
  }).filter(x => x.t && x.u && ['時報新聞', '經濟日報', '中央社'].includes(x.s));
}
const old = (() => { try { return JSON.parse(fs.readFileSync('pm/news.json', 'utf8')); } catch { return {}; } })();
const out = { updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), log: [] };
for (const [k, qs] of Object.entries(Q)) {
  const all = [];
  for (const q of qs) {
    try { all.push(...await rss(q)); } catch (e) { out.log.push(`⚠️ ${k}：${e.message}`); }
    await new Promise(r => setTimeout(r, 800));
  }
  const seen = new Set();
  out[k] = all.sort((a, b) => b.at - a.at).filter(x => { const key = x.t.replace(/\s|《[^》]*》|〈[^〉]*〉/g, '').slice(0, 16); return !seen.has(key) && seen.add(key); }).slice(0, 60);
  if (!out[k].length && Array.isArray(old[k])) out[k] = old[k];
  out.log.push(`${k}：${out[k].length} 則`);
}
console.log(out.log.join('\n'));
fs.writeFileSync('pm/news.json', JSON.stringify(out));
