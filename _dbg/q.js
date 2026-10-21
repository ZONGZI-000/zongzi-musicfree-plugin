global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
(async()=>{
  for(const q of ["Adele Easy On Me","Coldplay Up&Up","Taylor Swift All Too Well"]){
    let a;try{a=await p.search(q,1,"music")}catch(e){console.log(q,"SEARCH FAIL",e.message.slice(0,60));continue}
    const yt=(a.data||[]).filter(x=>x.platform==="YouTube").slice(0,2);
    for(const t of yt){
      for(const qual of ["standard","320k"]){
        const s=Date.now();
        try{
          const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),qual);
          const u=String(r.url);
          console.log(" "+(u.startsWith("data:")?"INLINE "+(Math.round(u.length/1024)+"KB"):"STREAM").padEnd(14),(Date.now()-s)+"ms",qual,t.title.slice(0,22));
        }catch(e){console.log("  FAIL",qual,t.title.slice(0,18),e.message.slice(0,60));}
      }
    }
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
