const file=process.argv[2];
global.env={userVariables:{}};
const p=require(file);
(async()=>{
  let inline=0,stream=0,fail=0;
  for(const q of ["Coldplay","Taylor Swift","赵薇"]){
    const a=await p.search(q,1,"music");
    for(const t of (a.data||[]).filter(x=>x.platform==="YouTube").slice(0,4)){
      try{
        const r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard");
        if(String(r.url).startsWith("data:"))inline++; else stream++;
      }catch(e){fail++;}
    }
  }
  console.log("VERDICT inline="+inline+" stream="+stream+" fail="+fail);
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
