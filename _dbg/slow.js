/* 模拟慢网：给 axios.get 的响应按「体积 / 速率」加人工延迟，
   超过该请求的 timeout 就按超时失败。用来复现用户手机上的 25KB/s VPN。 */
const RATE = Number(process.env.RATE_KBPS || 25) * 1024;
const axios = require("axios");
const origGet = axios.get.bind(axios);
const stats = {};
function keyOf(u){ try{ return new URL(u).host }catch(e){ return String(u).slice(0,30) } }
axios.get = async function(url, cfg){
  cfg = cfg || {};
  const t0 = Date.now();
  const r = await origGet(url, cfg);
  let size = 0;
  if (typeof r.data === "string") size = Buffer.byteLength(r.data);
  else if (r.data && r.data.byteLength) size = r.data.byteLength;
  else if (r.data) size = Buffer.byteLength(JSON.stringify(r.data));
  const realMs = Date.now() - t0;
  const extraMs = Math.max(0, (size / RATE) * 1000 - realMs);
  const to = Number(cfg.timeout) || 0;
  const k = keyOf(url);
  stats[k] = stats[k] || { n: 0, bytes: 0, maxMs: 0 };
  stats[k].n++; stats[k].bytes += size;
  stats[k].maxMs = Math.max(stats[k].maxMs, extraMs + realMs);
  if (to && extraMs + realMs > to) {
    const e = new Error("timeout of " + to + "ms exceeded (simulated " + Math.round((extraMs+realMs)/1000) + "s for " + Math.round(size/1024) + "KB)");
    e.code = "ECONNABORTED";
    throw e;
  }
  if (extraMs > 0) await new Promise((res) => setTimeout(res, extraMs));
  return r;
};
process.on("exit", () => {
  console.log("\n=== SLOW-NET STATS @" + Math.round(RATE/1024) + "KB/s ===");
  Object.keys(stats).sort((a,b)=>stats[b].bytes-stats[a].bytes).slice(0,12).forEach(k=>{
    const s=stats[k];
    console.log("  "+k.padEnd(34), "req="+String(s.n).padStart(3), (s.bytes/1024).toFixed(0).padStart(6)+"KB", "slowest="+Math.round(s.maxMs)+"ms");
  });
});

global.env = { userVariables: {} };
const p = require("D:/workspace/zongzi-musicfree-plugin/_dbg/r58.js");
(async () => {
  const qs = (process.env.QUERIES || "Coldplay,Taylor Swift,赵薇").split(",");
  for (const q of qs) {
    const t0 = Date.now();
    let a;
    try { a = await p.search(q, 1, "music"); }
    catch (e) { console.log("SEARCH FAIL", q, (Date.now()-t0)+"ms", e.message.slice(0,110)); continue; }
    const list = a.data || [];
    const by = {}; list.forEach(x => by[x.platform] = (by[x.platform]||0)+1);
    console.log("\n### " + q + " | search " + (Date.now()-t0) + "ms | n=" + list.length + " | " + JSON.stringify(by));
    const yt = list.filter(x => x.platform === "YouTube").slice(0, 3);
    for (const t of yt) {
      const s = Date.now();
      try {
        const r = await p.getMediaSource(JSON.parse(JSON.stringify(t)), "standard");
        const u = String(r.url || "");
        console.log("   " + (Date.now()-s) + "ms " + (u.startsWith("data:") ? "INLINE " + Math.round(u.length/1024) + "KB" : "STREAM") + " | " + t.title.slice(0,20));
      } catch (e) { console.log("   " + (Date.now()-s) + "ms FAIL | " + t.title.slice(0,20) + " | " + e.message.slice(0,100)); }
    }
  }
  process.exit(0);
})().catch(e => { console.log("FATAL", e && e.stack); process.exit(1); });
