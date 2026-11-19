// 盤前看板「即時行情轉接站」— 部署在 Cloudflare Workers（免費方案）
// /q?s=tse_t00.tw|tse_2330.tw   → 證交所即時報價（上市、上櫃、指數、類股指數）
// /fut?m=0（白天盤）或 m=1（夜盤） → 期交所台指期即時報價
// 每份資料快取 10 秒，避免太頻繁打到交易所而被封鎖
const ALLOW = ['https://cwh19870422.github.io', 'http://localhost:8765'];
const TTL = 10;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOW.includes(origin) ? origin : ALLOW[0],
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    let upstream, init = { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mis.twse.com.tw/stock/index.jsp' } };

    // 自選股同步：GET/PUT /wl/{同步碼}。同步碼由網頁第一次使用時隨機產生（24 碼以上），資料存在 KV（綁定名稱 WL）
    const wl = url.pathname.match(/^\/wl\/([A-Za-z0-9_-]{24,64})$/);
    if (wl) {
      const k = 'wl:' + wl[1];
      if (req.method === 'GET') return new Response((await env.WL.get(k)) || '{}', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
      if (req.method === 'PUT') {
        const body = await req.text();
        if (body.length > 200000) return json({ error: 'too large' }, 413, cors);
        try { JSON.parse(body); } catch { return json({ error: 'bad json' }, 400, cors); }
        await env.WL.put(k, body);
        return json({ ok: true }, 200, cors);
      }
      return json({ error: 'method' }, 405, cors);
    }
    // 新聞：/news?t=tw（台股）| intl（國際）| ann（重大訊息）| ptt（PTT 股票版）
    if (url.pathname === '/news') {
      const t = ['tw', 'intl', 'ann', 'ptt'].includes(url.searchParams.get('t')) ? url.searchParams.get('t') : 'tw';
      const cache = caches.default, key = new Request(`https://cache.local/news/${t}`);
      const hit = await cache.match(key);
      if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
      let items = [];
      try { items = await NEWS[t](); } catch (e) { items = []; }
      const body = JSON.stringify({ t, at: Date.now(), items });
      if (items.length) ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${t === 'ann' ? 300 : 60}` } })));
      return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
    }
    if (url.pathname === '/q') {
      const s = (url.searchParams.get('s') || '').toLowerCase();
      if (!/^[a-z0-9_.|]{5,3000}$/.test(s) || s.split('|').length > 150) return json({ error: 'bad request' }, 400, cors);
      upstream = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${s}&json=1&delay=0`;
    } else if (url.pathname === '/fut') {
      const m = url.searchParams.get('m') === '1' ? '1' : '0';
      upstream = 'https://mis.taifex.com.tw/futures/api/getQuoteList';
      init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://mis.taifex.com.tw/futures/' },
        body: JSON.stringify({ MarketType: m, SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }),
      };
    } else {
      return json({ ok: true, usage: ['/q?s=tse_t00.tw|tse_2330.tw', '/fut?m=0', '/fut?m=1'] }, 200, cors);
    }

    // 10 秒快取（以完整網址為鍵）
    const cache = caches.default, key = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return new Response(hit.body, { headers: { ...Object.fromEntries(hit.headers), ...cors, 'X-Cache': 'HIT' } });

    try {
      const r = await fetch(upstream, init);
      const body = await r.text();
      const res = new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${TTL}` } });
      if (r.ok) ctx.waitUntil(cache.put(key, res.clone()));
      return new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors, 'X-Cache': 'MISS' } });
    } catch (e) {
      return json({ error: String(e) }, 502, cors);
    }
  },
};
const json = (o, status, cors) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });

// ---------- 新聞來源 ----------
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const dec = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, '').trim();
async function cnyes(cat, src) {
  const r = await fetch(`https://api.cnyes.com/media/api/v1/newslist/category/${cat}?limit=30`, { headers: UA });
  const j = await r.json();
  return (j.items?.data || []).map(x => ({ t: x.title, u: `https://news.cnyes.com/news/id/${x.newsId}`, s: src, at: x.publishAt * 1000, st: (x.market || []).map(m => m.code) }));
}
async function gnews(q) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { headers: UA });
  const xml = await r.text();
  return xml.split('<item>').slice(1).map(it => {
    const g = tag => dec((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1]);
    const src = g('source'); let t = g('title'); if (src && t.endsWith(' - ' + src)) t = t.slice(0, -(src.length + 3));
    return { t, u: g('link'), s: src.replace(/新聞網$|－.*$/, ''), at: Date.parse(g('pubDate')) || 0, st: [] };
  });
}
const SITES = '(site:ctee.com.tw OR site:money.udn.com OR site:cna.com.tw)';
const srcName = s => /工商|時報|ctee/i.test(s) ? '時報新聞' : /經濟日報|udn/i.test(s) ? '經濟日報' : /中央社|cna/i.test(s) ? '中央社' : s;
function merge(lists, n = 60) {
  const seen = new Set(), out = [];
  lists.flat().filter(x => x && x.t).sort((a, b) => b.at - a.at).forEach(x => {
    const k = x.t.replace(/\s|《[^》]*》|〈[^〉]*〉/g, '').slice(0, 16);
    if (!seen.has(k)) { seen.add(k); out.push({ ...x, s: srcName(x.s) }); }
  });
  return out.slice(0, n);
}
const settle = ps => Promise.allSettled(ps).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : []));
const NEWS = {
  tw: async () => merge(await settle([cnyes('tw_stock', '鉅亨網'), gnews(`(台股 OR 股市 OR 個股 OR 法人) ${SITES} when:1d`), gnews(`(上市 OR 上櫃 OR 營收 OR 外資) ${SITES} when:1d`)])),
  intl: async () => merge(await settle([cnyes('wd_stock', '鉅亨網'), gnews(`(美股 OR 聯準會 OR Fed OR 美債 OR 油價 OR 道瓊 OR 費半 OR 輝達) ${SITES} when:1d`)])),
  ann: async () => {
    const [a, b] = await settle([fetch('https://openapi.twse.com.tw/v1/opendata/t187ap04_L', { headers: UA }).then(r => r.json()), fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O', { headers: UA }).then(r => r.json())]);
    const pick = (o, ...ks) => { for (const k of Object.keys(o)) if (ks.some(x => k.includes(x))) return o[k]; return ''; };
    const roc = (d, t) => { d = String(d || ''); t = String(t || '').padStart(6, '0'); if (d.length < 7) return 0; return Date.parse(`${+d.slice(0, d.length - 4) + 1911}-${d.slice(-4, -2)}-${d.slice(-2)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+08:00`) || 0; };
    return [...(a || []), ...(b || [])].map(x => {
      const c = String(pick(x, '公司代號', 'SecuritiesCompanyCode', 'CompanyCode')).trim(), n = String(pick(x, '公司名稱', 'CompanyName', 'CompanyAbbreviation')).trim();
      return { t: `${n}：${String(pick(x, '主旨', 'Subject')).trim()}`, u: `https://mops.twse.com.tw/mops/web/t146sb10?co_id=${c}`, s: '重大訊息', at: roc(pick(x, '發言日期', 'DateOfAnnouncement', 'Date'), pick(x, '發言時間', 'TimeOfAnnouncement', 'Time')), st: c ? [c] : [] };
    }).filter(x => x.t.length > 3).sort((a, b) => b.at - a.at).slice(0, 80);
  },
  ptt: async () => {
    const out = []; let url = 'https://www.ptt.cc/bbs/Stock/index.html';
    for (let p = 0; p < 2 && url; p++) {
      const html = await (await fetch(url, { headers: { ...UA, Cookie: 'over18=1' } })).text();
      const prev = (html.match(/href="(\/bbs\/Stock\/index\d+\.html)"[^>]*>[^<]*上頁/) || [])[1];
      html.split('<div class="r-ent">').slice(1).forEach(b => {
        const a = b.match(/<a href="([^"]+)">([\s\S]*?)<\/a>/); if (!a) return;
        const nrec = dec((b.match(/<div class="nrec">([\s\S]*?)<\/div>/) || [])[1]);
        const id = (a[1].match(/M\.(\d+)\./) || [])[1];
        out.push({ t: dec(a[2]), u: 'https://www.ptt.cc' + a[1], s: 'PTT', at: id ? +id * 1000 : 0, push: nrec, st: [] });
      });
      url = prev ? 'https://www.ptt.cc' + prev : null;
    }
    return out.filter(x => !/^\[公告\]|置底/.test(x.t)).sort((a, b) => b.at - a.at).slice(0, 50);
  },
};
