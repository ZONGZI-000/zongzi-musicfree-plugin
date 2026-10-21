global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/_dbg/r58.js");
const https=require("https"),{URL}=require("url");
function go(url,headers){
  return new Promise(res=>{
    const u=new URL(url);const t0=Date.now();
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,port:443,method:"GET",headers},r=>{
      let n=0;r.on("data",c=>{n+=c.length;if(n>=2048){req.destroy();fin()}});
      r.on("end",fin);
      function fin(){res({code:r.statusCode,n,cr:r.headers["content-range"]||"(none)",ms:Date.now()-t0});}
    });
    req.setTimeout(12000,()=>{req.destroy();res({err:"timeout"})});
    req.on("error",e=>res({err:String(e.message).slice(0,26)}));
    req.end();
  });
}
(async()=>{
  const a=await p.search("Coldplay",1,"music");
  const yt=(a.data||[]).filter(x=>x.platform==="YouTube");
  for(const t of yt.slice(0,2)){
    let r;try{r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard")}catch(e){continue}
    const u=String(r.url||"");
    if(u.startsWith("data:"))continue;
    const clean=u.replace(/&range=[^&]*/,"");
    console.log("\n"+t.title.slice(0,22));
    console.log("  [交付的URL] Range头 500000- :",JSON.stringify(await go(u,{Range:"bytes=500000-"})));
    console.log("  [交付的URL] Range头 1200000-:",JSON.stringify(await go(u,{Range:"bytes=1200000-"})));
    console.log("  [去掉range参数] 500000-     :",JSON.stringify(await go(clean,{Range:"bytes=500000-"})));
    console.log("  [去掉range参数] 1200000-    :",JSON.stringify(await go(clean,{Range:"bytes=1200000-"})));
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
