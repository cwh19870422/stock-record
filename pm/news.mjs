// 國際影響經濟的重大新聞（Google 新聞 RSS，近 2 天）→ pm/news.json
import fs from 'node:fs';

const UA = { 'User-Agent': 'Mozilla/5.0 (stock-record news)' };
const TOPICS = [
  ['🏦 央行與利率', '聯準會 OR Fed OR 降息 OR 升息 OR 鮑爾 OR 央行 利率'],
  ['📊 經濟數據', 'CPI OR 通膨 OR 非農 OR 就業數據 OR GDP OR PMI 美國'],
  ['🇺🇸 美股動態', '美股 收盤 道瓊 那斯達克 費半'],
  ['💻 科技與半導體', '輝達 OR 半導體 OR AI晶片 OR 台積電 國際'],
  ['🌐 貿易與地緣政治', '關稅 OR 貿易戰 OR 出口管制 OR 制裁 OR 地緣政治'],
  ['🛢️ 原物料與匯率', '油價 OR 美元指數 OR 美債殖利率 OR 國際金價 OR 日圓匯率'],
];
const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();

async function rss(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:2d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = await r.text();
  return xml.split('<item>').slice(1).map(it => {
    const g = t => dec((it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '');
    const s = g('source');
    let t = g('title'); if (s && t.endsWith(' - ' + s)) t = t.slice(0, -(s.length + 3));
    const time = Date.parse(g('pubDate'));
    return { t, u: g('link'), s, time: Number.isFinite(time) ? time : 0 };
  }).filter(x => x.t && x.u);
}

const old = (() => { try { return JSON.parse(fs.readFileSync('pm/news.json', 'utf8')); } catch { return { topics: [] }; } })();
const seen = new Set(), topics = [], log = [];
for (const [name, q] of TOPICS) {
  try {
    const items = (await rss(q)).sort((a, b) => b.time - a.time)
      .filter(x => { const k = x.t.replace(/\s/g, '').slice(0, 18); return !seen.has(k) && seen.add(k); }).slice(0, 6);
    topics.push({ name, items });
    log.push(`${name}：${items.length} 則`);
  } catch (e) {
    const keep = old.topics.find(x => x.name === name);
    if (keep) topics.push(keep);
    log.push(`⚠️ ${name}：${e.message}`);
  }
  await new Promise(r => setTimeout(r, 800));
}
console.log(log.join('\n'));
fs.writeFileSync('pm/news.json', JSON.stringify({ updated: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), topics, log }));
