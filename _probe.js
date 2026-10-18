const axios = require("axios");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_M = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

(async () => {
  const q = process.argv[2] || "摇晃帝国";
  // 酷我歌手搜索
  try {
    const r = await axios.get("http://search.kuwo.cn/r.s", {
      params: { all: q, ft: "artist", itemset: "web_2013", client: "kt", pn: 0, rn: 10, rformat: "json", encoding: "utf8", pcjson: 1 },
      timeout: 12000, headers: { "User-Agent": UA, Referer: "http://www.kuwo.cn/" }, validateStatus: () => true,
    });
    const raw = typeof r.data === "string" ? r.data.replace(/'/g, '"') : r.data;
    const abs = (raw && raw.abslist) || [];
    console.log("== 酷我歌手:", abs.length);
    abs.forEach(a => console.log("  ", a.ARTIST, "| id:", a.ARTISTID, "| songs:", a.SONGNUM));
  } catch (e) { console.log("酷我 ERR", e.message); }

  // 酷狗歌手搜索
  try {
    const r2 = await axios.get("http://mobilecdn.kugou.com/api/v3/search/singer", {
      params: { format: "json", keyword: q, page: 1, pagesize: 8 },
      timeout: 12000, headers: { "User-Agent": UA_M }, validateStatus: () => true,
    });
    const arr = (r2.data && (r2.data.data || r2.data.info)) || [];
    console.log("== 酷狗歌手:", Array.isArray(arr) ? arr.length : typeof arr);
    (Array.isArray(arr) ? arr : []).forEach(a => console.log("  ", a.singername, "| id:", a.singerid));
  } catch (e) { console.log("酷狗 ERR", e.message); }
})();
