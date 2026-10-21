global.env={userVariables:{prefetch:"0"}};
const p=require("./t2.js");
(async()=>{
 for(const q of ["晴天 周杰伦","起风了 买辣椒也用券","赵薇 天使旅行箱"]){
   const s=await p.search(q,1,"music");
   const list=(s.data||[]).slice(0,3);
   console.log("\n### "+q);
   for(const it of list){
     const t0=Date.now();
     try{ const r=await p.getMediaSource(it,"standard"); const u=r.url||"";
       console.log("  ["+it.platform+"] "+it.title+" → "+(u.startsWith("data:")?"INLINE "+Math.round(u.length/1024)+"KB":"STREAM "+(u.slice(0,30)))+" "+(Date.now()-t0)+"ms");
     }catch(e){ console.log("  ["+it.platform+"] "+it.title+" → FAIL "+String(e.message).slice(0,80)); }
   }
 }
})();
