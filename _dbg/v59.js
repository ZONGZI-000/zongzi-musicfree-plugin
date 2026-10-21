global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
(async()=>{
  let inline=0,stream=0,fail=0; const detail=[];
  for(const q of ["Coldplay","Taylor Swift","赵薇","怎麼都沒有了"]){
    const a=await p.search(q,1,"music");
    const yt=(a.data||[]).filter(x=>x.platform==="YouTube").slice(0,4);
    for(const t of yt){
      const s=Date.now();
      try{
        const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard");
        const isIn=String(r.url).startsWith("data:");
        isIn?inline++:stream++;
        detail.push(" "+(isIn?"INLINE":"STREAM")+" "+(Date.now()-s)+"ms "+t.title.slice(0,18));
      }catch(e){fail++;detail.push(" FAIL "+t.title.slice(0,18)+" "+e.message.slice(0,50));}
    }
  }
  console.log(detail.join("\n"));
  console.log("VERDICT inline="+inline+" stream="+stream+" fail="+fail);
  process.exit(0);
})().catch(e=>{console.log("FATAL",e&&e.stack);process.exit(1)});
