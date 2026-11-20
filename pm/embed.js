// 在「股票記錄」App 裡被內嵌時：點到另一個分頁的連結，就請 App 切換分頁
(() => {
  if (window.top === window.self) return;
  document.documentElement.classList.add('embed');
  const tabOf = p => p === 'premarket.html' ? 'pre' : (p === 'chart.html' || p === 'watch.html') ? 'k' : null;
  const me = tabOf(location.pathname.split('/').pop());
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]'); if (!a || a.target === '_blank') return;
    const u = new URL(a.getAttribute('href'), location.href); if (u.origin !== location.origin) return;
    const page = u.pathname.split('/').pop(), tab = tabOf(page);
    if (tab && tab !== me) { e.preventDefault(); e.stopPropagation(); parent.postMessage({ appGo: tab, url: page + u.search }, location.origin); }
  }, true);
})();

// 在 App 裡時：把這頁的標題列（標題、同步／即時狀態、右上連結）交給 App 上方的標題列顯示，這頁自己不再重複顯示
(() => {
  if (window.top === window.self) return;
  const run = () => {
    const hdr = document.querySelector('header'), h1 = hdr && hdr.querySelector('h1');
    if (!h1) return;
    const row = h1.parentElement, sub = hdr.querySelector('.sub'), links = [...row.querySelectorAll('a')];
    row.style.display = 'none'; if (sub) sub.style.display = 'none';
    hdr.style.paddingTop = '6px';
    let last = '';
    const send = () => {
      const msg = { appHead: { title: h1.textContent.trim(), sub: sub ? sub.innerHTML : '', links: links.map(a => a.textContent.trim()) } };
      const k = JSON.stringify(msg); if (k === last) return; last = k;
      parent.postMessage(msg, location.origin);
    };
    new MutationObserver(send).observe(hdr, { subtree: true, childList: true, characterData: true });
    addEventListener('message', e => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.appClick != null) links[e.data.appClick]?.click();
      if (e.data.appHeadAsk) { last = ''; send(); }
    });
    send();
  };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', run) : run();
})();
