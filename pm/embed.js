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
