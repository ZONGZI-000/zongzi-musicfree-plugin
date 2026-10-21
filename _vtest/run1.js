global.env={userVariables:{prefetch:"0"}};
const p=require("./t1.js");
(async()=>{
 const s=await p.search("赵薇 天使旅行箱",1,"music");
 const list=(s.data||[]).slice(0,3);
 for(const it of list){
   const t0=Date.now();
   try{ const r=await p.getMediaSource(it,"standard"); const u=r.url||"";
     console.log("["+it.platform+"] "+it.title+" → "+(u.startsWith("data:")?"INLINE "+Math.round(u.length/1024)+"KB":"STREAM")+" "+(Date.now()-t0)+"ms");
   }catch(e){ console.log("["+it.platform+"] "+it.title+" → FAIL "+(Date.now()-t0)+"ms "+String(e.message).slice(0,100)); }
 }
})();
