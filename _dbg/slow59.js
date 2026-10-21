const RATE = Number(process.env.RATE_KBPS || 25) * 1024;
const axios = require("axios");
const og = axios.get.bind(axios), op = axios.post.bind(axios);
const stats = {};
function rec(k,bytes,ms,to){const s=stats[k]=stats[k]||{n:0,bytes:0,slow:0,fail:0};s.n++;s.bytes+=bytes;s.slow=Math.max(s.slow,ms);if(to&&ms>to)s.fail++;}
async function wrap(url,cfg,fn){
  cfg=cfg||{}; const t0=Date.now(); const r=await fn(url,cfg); const real=Date.now()-t0;
  const cl=Number((r.headers&&(r.headers["content-length"]||r.headers["Content-Length"]))||0);
  const tr=cl||(typeof r.data==="string"?Buffer.byteLength(r.data):(r.data&&r.data.byteLength)||0);
  const total=(tr/RATE)*1000, to=Number(cfg.timeout)||0;
  let h="?"; try{h=new URL(url).host}catch(e){}
  rec(h,tr,total,to);
  if(to&&total>to){const e=new Error("timeout of "+to+"ms exceeded (sim "+Math.round(total/1000)+"s / "+Math.round(tr/1024)+"KB)");e.code="ECONNABORTED";throw e;}
  const extra=Math.max(0,total-real); if(extra>0) await new Promise(z=>setTimeout(z,extra));
  return r;
}
axios.get=(u,c)=>wrap(u,c,og); axios.post=(u,d,c)=>wrap(u,c,(uu,cc)=>op(uu,d,cc));
process.on("exit",()=>{
  console.log("\n=== SLOW @"+Math.round(RATE/1024)+"KB/s ===");
  Object.keys(stats).sort((a,b)=>stats[b].bytes-stats[a].bytes).slice(0,8).forEach(k=>{
    const s=stats[k];console.log("  "+k.padEnd(30),"req="+String(s.n).padStart(3),(s.bytes/1024).toFixed(0).padStart(6)+"KB","slow="+Math.round(s.slow)+"ms","timeout="+s.fail);});
});
global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
(async()=>{
  let inline=0,stream=0,fail=0;
  for(const q of (process.env.QUERIES||"Coldplay,赵薇").split(",")){
    const t0=Date.now(); let a;
    try{a=await p.search(q,1,"music");}catch(e){console.log("SEARCH FAIL",q,(Date.now()-t0)+"ms",e.message.slice(0,90));continue;}
    const list=a.data||[]; const by={}; list.forEach(x=>by[x.platform]=(by[x.platform]||0)+1);
    console.log("\n### "+q+" | search "+(Date.now()-t0)+"ms | n="+list.length+" | "+JSON.stringify(by));
    for(const t of list.filter(x=>x.platform==="YouTube").slice(0,3)){
      const s=Date.now();
      try{const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard");
        const inl=String(r.url).startsWith("data:"); inl?inline++:stream++;
        console.log("   "+(Date.now()-s)+"ms "+(inl?"INLINE "+Math.round(String(r.url).length/1024)+"KB":"STREAM")+" | "+t.title.slice(0,18));
      }catch(e){fail++;console.log("   "+(Date.now()-s)+"ms FAIL | "+t.title.slice(0,18)+" | "+e.message.slice(0,90));}
    }
  }
  console.log("VERDICT inline="+inline+" stream="+stream+" fail="+fail);
  process.exit(0);
})().catch(e=>{console.log("FATAL",e&&e.stack);process.exit(1)});
