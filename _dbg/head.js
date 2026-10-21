global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
const https=require("https"),{URL}=require("url");
function req(url,method,headers){
  return new Promise(res=>{
    const u=new URL(url);const t0=Date.now();
    const r=https.request({hostname:u.hostname,path:u.pathname+u.search,port:443,method,headers},x=>{
      let n=0;x.on("data",c=>{n+=c.length;if(n>=512){r.destroy();fin()}});
      x.on("end",fin);
      function fin(){res({code:x.statusCode,n,ms:Date.now()-t0,cl:x.headers["content-length"]||"-",ct:x.headers["content-type"]||"-",cr:x.headers["content-range"]||"-"});}
    });
    r.setTimeout(12000,()=>{r.destroy();res({err:"timeout"})});
    r.on("error",e=>res({err:String(e.message).slice(0,26)}));
    r.end();
  });
}
(async()=>{
  const a=await p.search("Coldplay",1,"music");
  const yt=(a.data||[]).filter(x=>x.platform==="YouTube");
  const t=yt[1];
  let r;try{r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard")}catch(e){console.log("FAIL",e.message.slice(0,60));process.exit(0)}
  const u=String(r.url||"");
  if(u.startsWith("data:")){console.log("inline; skip");process.exit(0)}
  console.log("HEAD        :",JSON.stringify(await req(u,"HEAD",{})));
  console.log("HEAD+range  :",JSON.stringify(await req(u,"HEAD",{Range:"bytes=0-"})));
  console.log("GET twice   :",JSON.stringify(await req(u,"GET",{})),JSON.stringify(await req(u,"GET",{})));
  console.log("url expire  :",new URL(u).searchParams.get("expire"),"| now:",Math.floor(Date.now()/1000));
  console.log("has range p :",/[?&]range=/.test(u));
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
