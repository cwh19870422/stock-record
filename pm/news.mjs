// 時報新聞、經濟日報、中央社（透過 Google 新聞 RSS，近 1 天）→ pm/news.json
// 鉅亨網、重大訊息、PTT 由 Cloudflare 轉接站即時抓；這三家 Google 會擋轉接站，所以改由這裡每 30 分鐘抓一次
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', 'Accept-Language': 'zh-TW,zh;q=0.9' };
// Google 會擋帶 site: 的自動查詢，改用「關鍵字＋媒體名稱」查，再依來源過濾
const MEDIA = ['經濟日報', '中央社', '工商時報'];
const Q = {
  tw: MEDIA.flatMap(m => [`台股 ${m}`, `個股 法人 ${m}`]),
  intl: MEDIA.flatMap(m => [`美股 聯準會 ${m}`]),
};
const dec = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
const srcName = s => /工商|時報|ctee/i.test(s) ? '時報新聞' : /經濟日報|udn/i.test(s) ? '經濟日報' : /中央社|cna/i.test(s) ? '中央社' : s;

async function rss(q) {
  let r;
  for (let t = 0; t < 3; t++) {
    r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { headers: UA });
    if (r.ok) break;
    await new Promise(res => setTimeout(res, 4000 + t * 6000));
  }
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
    await new Promise(r => setTimeout(r, 1500));
  }
  const seen = new Set();
  out[k] = all.sort((a, b) => b.at - a.at).filter(x => { const key = x.t.replace(/\s|《[^》]*》|〈[^〉]*〉/g, '').slice(0, 16); return !seen.has(key) && seen.add(key); }).slice(0, 60);
  if (!out[k].length && Array.isArray(old[k])) out[k] = old[k];
  out.log.push(`${k}：${out[k].length} 則`);
}
console.log(out.log.join('\n'));
fs.writeFileSync('pm/news.json', JSON.stringify(out));
