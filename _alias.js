// 临时：直接调内部别名反查（通过 rewire 太麻烦，这里复制一份核心逻辑跑）
const axios = require("axios");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function normTextZ(s) {
  return String(s || "").toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[·・.,，。!！?？;；:：'"“”‘’\-—_/\\|~～&＆+＋*※#＃]/g, "")
    .trim();
}
function lcsLen(a, b) {
  a = normTextZ(a); b = normTextZ(b);
  if (!a || !b) return 0;
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) { dp[j] = prev + 1; if (dp[j] > best) best = dp[j]; }
      else dp[j] = 0;
      prev = tmp;
    }
  }
  return best;
}

(async () => {
  const q = process.argv[2] || "摇晃帝国";
  // 1) 网易云歌手搜索
  try {
    const r = await axios.post("https://music.163.com/api/cloudsearch/pc", 
      new URLSearchParams({ s: q, type: "100", limit: "10", offset: "0" }).toString(),
      { timeout: 10000, headers: { "User-Agent": UA, Referer: "https://music.163.com/",
        "Content-Type": "application/x-www-form-urlencoded" }, validateStatus: () => true });
    const ars = (r.data && r.data.result && r.data.result.artists) || [];
    console.log("== 网易云歌手:", ars.length);
    ars.slice(0, 5).forEach(a => console.log("  ", a.name, "| alias:", JSON.stringify(a.alias), "| tns:", JSON.stringify(a.transNames || a.trans)));
  } catch (e) { console.log("网易云 ERR", e.message); }

  // 2) QQ 歌手搜索
  try {
    const q2 = await axios.get("https://c.y.qq.com/soso/fcgi-bin/client_search_cp", {
      params: { w: q, t: 9, p: 1, n: 5, format: "json" }, timeout: 10000,
      headers: { "User-Agent": UA, Referer: "https://y.qq.com/" }, validateStatus: () => true });
    const sl = (q2.data && q2.data.data && q2.data.data.singer && q2.data.data.singer.list) || [];
    console.log("== QQ歌手:", sl.length);
    sl.forEach(s => console.log("  ", s.singerName, "| mid:", s.singerMid, "| n:", s.songNum));
  } catch (e) { console.log("QQ ERR", e.message); }
})();
