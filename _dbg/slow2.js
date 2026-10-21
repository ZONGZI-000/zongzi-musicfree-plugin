/* 更真实的慢网模拟：按「传输字节」（Content-Length，压缩后）算耗时 */
const RATE = Number(process.env.RATE_KBPS || 25) * 1024;
const axios = require("axios");
const origGet = axios.get.bind(axios);
const origPost = axios.post.bind(axios);
const stats = {};
function host(u){ try{ return new URL(u).host }catch(e){ return String(u).slice(0,26) } }
function rec(k, bytes, ms, ok){
  const s = stats[k] = stats[k] || { n:0, bytes:0, slowest:0, fails:0 };
  s.n++; s.bytes += bytes; s.slowest = Math.max(s.slowest, ms); if(!ok) s.fails++;
}
async function wrap(url, cfg, fn){
  cfg = cfg || {};
  const t0 = Date.now();
  const r = await fn(url, cfg);
  const realMs = Date.now() - t0;
  const cl = Number((r.headers && (r.headers["content-length"]||r.headers["Content-Length"])) || 0);
  const transfer = cl || (typeof r.data === "string" ? Buffer.byteLength(r.data) : (r.data && r.data.byteLength) || 0);
  const totalMs = (transfer / RATE) * 1000;
  const extraMs = Math.max(0, totalMs - realMs);
  const to = Number(cfg.timeout) || 0;
  rec(host(url), transfer, totalMs, !to || totalMs <= to);
  if (to && totalMs > to) {
    const e = new Error("timeout of " + to + "ms exceeded (simulated " + Math.round(totalMs/1000) + "s for " + Math.round(transfer/1024) + "KB)");
    e.code = "ECONNABORTED"; throw e;
  }
  if (extraMs > 0) await new Promise(res => setTimeout(res, extraMs));
  return r;
}
axios.get = (u, c) => wrap(u, c, origGet);
axios.post = (u, d, c) => wrap(u, c, (uu, cc) => origPost(uu, d, cc));
process.on("exit", () => {
  console.log("\n=== SLOW-NET @" + Math.round(RATE/1024) + "KB/s ===");
  Object.keys(stats).sort((a,b)=>stats[b].bytes-stats[a].bytes).slice(0,10).forEach(k=>{
    const s=stats[k];
    console.log("  "+k.padEnd(32),"req="+String(s.n).padStart(3),(s.bytes/1024).toFixed(0).padStart(6)+"KB","slow="+Math.round(s.slowest)+"ms","timeouts="+s.fails);
  });
});
global.env = { userVariables: {} };
const p = require("D:/workspace/zongzi-musicfree-plugin/_dbg/r58.js");
(async () => {
  for (const q of (process.env.QUERIES||"Coldplay").split(",")) {
    const t0 = Date.now();
    let a;
    try { a = await p.search(q, 1, "music"); }
    catch (e) { console.log("SEARCH FAIL", q, (Date.now()-t0)+"ms", e.message.slice(0,120)); continue; }
    const list = a.data||[];
    const by={}; list.forEach(x=>by[x.platform]=(by[x.platform]||0)+1);
    console.log("\n### "+q+" | search "+(Date.now()-t0)+"ms | n="+list.length+" | "+JSON.stringify(by));
    for (const t of list.filter(x=>x.platform==="YouTube").slice(0,3)) {
      const s=Date.now();
      try{
        const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard");
        const u=String(r.url||"");
        console.log("   "+(Date.now()-s)+"ms "+(u.startsWith("data:")?"INLINE "+Math.round(u.length/1024)+"KB":"STREAM")+" | "+t.title.slice(0,20));
      }catch(e){console.log("   "+(Date.now()-s)+"ms FAIL | "+t.title.slice(0,20)+" | "+e.message.slice(0,110));}
    }
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e&&e.stack);process.exit(1)});
