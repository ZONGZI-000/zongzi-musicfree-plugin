global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
const https=require("https"),{URL}=require("url");
function req(url,method,headers){
  return new Promise(res=>{
    const u=new URL(url);const t0=Date.now();
    const r=https.request({hostname:u.hostname,path:u.pathname+u.search,port:443,method,headers},x=>{
      let n=0,b=Buffer.alloc(0);
      x.on("data",c=>{n+=c.length;if(b.length<200)b=Buffer.concat([b,c]).slice(0,200);if(n>=1024){r.destroy();fin()}});
      x.on("end",fin);
      function fin(){res({code:x.statusCode,n,ms:Date.now()-t0,body:b.toString("utf8").replace(/\n/g," ").slice(0,110)});}
    });
    r.setTimeout(12000,()=>{r.destroy();res({err:"timeout"})});
    r.on("error",e=>res({err:String(e.message).slice(0,26)}));
    r.end();
  });
}
(async()=>{
  const a=await p.search("Adele Hello",1,"music");
  const yt=(a.data||[]).filter(x=>x.platform==="YouTube");
  for(const t of yt.slice(0,3)){
    let r;try{r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard")}catch(e){console.log("FAIL",t.title.slice(0,14),e.message.slice(0,60));continue}
    const u=String(r.url||"");
    if(u.startsWith("data:")){console.log("INLINE",t.title.slice(0,14));continue}
    const v=await req(u,"GET",{});
    console.log(t.title.slice(0,20)," => ",JSON.stringify(v));
    console.log("   host:",new URL(u).host,"| itag:",new URL(u).searchParams.get("itag"));
  }
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
