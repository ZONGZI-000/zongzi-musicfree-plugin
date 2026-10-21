global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/_dbg/r58.js");
const https=require("https"),{URL}=require("url");
function go(url,headers){
  return new Promise(res=>{
    const u=new URL(url);const t0=Date.now();
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,port:443,method:"GET",headers},r=>{
      let n=0;r.on("data",c=>{n+=c.length;if(n>=2048){req.destroy();fin()}});
      r.on("end",fin);
      function fin(){res({code:r.statusCode,n,ms:Date.now()-t0,cr:r.headers["content-range"]||""});}
    });
    req.setTimeout(12000,()=>{req.destroy();res({err:"timeout"})});
    req.on("error",e=>res({err:String(e.message).slice(0,26)}));
    req.end();
  });
}
(async()=>{
  const a=await p.search("Coldplay",1,"music");
  const yt=(a.data||[]).filter(x=>x.platform==="YouTube");
  for(const t of yt.slice(0,3)){
    let r;try{r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard")}catch(e){console.log("FAIL",e.message.slice(0,50));continue}
    const u=String(r.url||"");
    if(u.startsWith("data:")){console.log("INLINE",t.title.slice(0,20));continue}
    console.log("\n"+t.title.slice(0,24));
    console.log("  no header        :",JSON.stringify(await go(u,{})));
    console.log("  Range: bytes=0-  :",JSON.stringify(await go(u,{Range:"bytes=0-"})));
    console.log("  plain bytes=0-1  :",JSON.stringify(await go(u.replace(/&range=[^&]*/,""),{Range:"bytes=0-"})));
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
