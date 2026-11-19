// 盤中即時行情（透過 Cloudflare 轉接站）— 盤前看板與 K 線頁共用
window.RT = (() => {
  const URL = 'https://tw-rt.cwh19870422.workers.dev';
  const tp = () => { const d = new Date(Date.now() + 8 * 3600e3); return { wd: d.getUTCDay(), m: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  // 現股 09:00～13:35；台指期日盤 08:45～13:50；夜盤 15:00～隔天 05:00
  const stockLive = () => { const { wd, m } = tp(); return wd >= 1 && wd <= 5 && m >= 535 && m <= 815; };
  const futSession = () => {
    const { wd, m } = tp();
    if (wd >= 1 && wd <= 5 && m >= 525 && m <= 830) return 0;
    if ((wd >= 1 && wd <= 5 && m >= 900) || (wd >= 2 && wd <= 6 && m <= 300)) return 1;
    return null;
  };
  const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  async function q(codes) {
    if (!URL || !codes.length) return {};
    const out = {};
    for (let i = 0; i < codes.length; i += 120) {
      const r = await fetch(`${URL}/q?s=${codes.slice(i, i + 120).join('|')}`);
      const j = await r.json();
      (j.msgArray || []).forEach(x => {
        if (!x.c) return;
        const y = n(x.y), z = n(x.z) ?? n(String(x.b || '').split('_')[0]) ?? n(String(x.a || '').split('_')[0]) ?? null; // 跌停沒買單時用委賣價
        out[x.c] = { c: x.c, name: x.n, z, y, o: n(x.o), h: n(x.h), l: n(x.l), v: n(x.v), t: x.t, d: x.d ? `${x.d.slice(0, 4)}-${x.d.slice(4, 6)}-${x.d.slice(6, 8)}` : null,
          ch: z != null && y ? z - y : null, p: z != null && y ? (z / y - 1) * 100 : null };
      });
    }
    return out;
  }
  async function fut(m) {
    if (!URL) return null;
    let j; try { const r = await fetch(`${URL}/fut?m=${m}`); if (!r.ok) return null; j = await r.json(); } catch { return null; }
    const rows = (j.RtData?.QuoteList || []).filter(x => /^TXF[A-Z]\d-[FM]$/.test(x.SymbolID));
    const best = rows.sort((a, b) => (n(b.CTotalVolume) || 0) - (n(a.CTotalVolume) || 0))[0];
    if (!best) return null;
    const z = n(best.CLastPrice), ref = n(best.CRefPrice);
    return { name: best.DispCName, z, ref, ch: n(best.CDiff) ?? (z - ref), p: n(best.CDiffRate), t: best.CTime, h: n(best.CHighPrice), l: n(best.CLowPrice), v: n(best.CTotalVolume), m };
  }
  const hhmmss = t => t ? String(t).replace(/^(\d{2}):?(\d{2}):?(\d{2}).*$/, '$1:$2:$3') : '';
  return { URL, on: !!URL, stockLive, futSession, q, fut, hhmmss, every: 20000 };
})();
