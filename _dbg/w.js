global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/_dbg/h58.js");
(async()=>{
  const a=await p.search("Coldplay",1,"music");
  for(const t of (a.data||[]).filter(x=>x.platform==="YouTube").slice(0,3)){
    const s=Date.now();
    try{const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard");
      console.log(">>",(Date.now()-s)+"ms",String(r.url).startsWith("data:")?"INLINE":"STREAM",t.title.slice(0,20));
    }catch(e){console.log(">> FAIL",e.message.slice(0,70));}
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e&&e.stack);process.exit(1)});
