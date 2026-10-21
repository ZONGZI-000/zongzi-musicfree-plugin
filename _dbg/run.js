global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/_dbg/h58.js");
(async()=>{
  const a=await p.search("Coldplay",1,"music");
  const yt=(a.data||[]).filter(x=>x.platform==="YouTube").slice(0,5);
  for(const t of yt){
    const s=Date.now();
    try{ const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard");
      console.log("  RESULT",(Date.now()-s)+"ms",String(r.url).startsWith("data:")?"INLINE "+Math.round(String(r.url).length/1024)+"KB":"STREAM",t.title.slice(0,22));
    }catch(e){console.log("  RESULT FAIL",e.message.slice(0,70));}
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e&&e.stack);process.exit(1)});
