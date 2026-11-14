# 股票記錄

個人台股買賣記錄 App（手機優先）。網址：https://cwh19870422.github.io/stock-record/

- 資料存在 Firebase（專案 my-stock-a493b），登入後各裝置同步
- `data/` 由 GitHub Actions 每天自動更新：股票清單、收盤價、加權指數
- 交易當日新聞：Actions 用機器人帳號（secret `BOT_PASSWORD`）抓 Google 新聞寫回 Firebase
- Firestore 規則見 `firestore.rules`
