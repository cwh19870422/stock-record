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
