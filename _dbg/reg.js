global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
const https=require("https"),http=require("http"),{URL}=require("url");
function probe(url,headers){
  return new Promise(res=>{
    let u;try{u=new URL(url)}catch(e){return res({err:"badurl"})}
    const mod=u.protocol==="https:"?https:http;const t0=Date.now();
    const req=mod.request({hostname:u.hostname,path:u.pathname+u.search,port:u.port||undefined,method:"GET",headers},r=>{
      if(r.statusCode>=300&&r.statusCode<400&&r.headers.location){
        req.destroy();let abs="/";try{abs=new URL(r.headers.location,url).href}catch(e){}
        return probe(abs,headers).then(x=>res(x));
      }
      let n=0,b=Buffer.alloc(0);
      r.on("data",c=>{n+=c.length;if(b.length<16)b=Buffer.concat([b,c]).slice(0,16);if(n>=1024){req.destroy();fin()}});
      r.on("end",fin);
      function fin(){const bb=b;let k=null;
        if(bb[0]===0x49&&bb[1]===0x44&&bb[2]===0x33)k="ID3";
        else if(bb[0]===0xff&&(bb[1]===0xfb||bb[1]===0xf3))k="MP3";
        else if(bb[0]===0x4f&&bb[1]===0x67)k="OGG";
        else if(bb[4]===0x66&&bb[5]===0x74&&bb[6]===0x79&&bb[7]===0x70)k="MP4";
        else if(bb[0]===0x1a&&bb[1]===0x45)k="WEBM";
        res({code:r.statusCode,kind:k,ms:Date.now()-t0});}
    });
    req.setTimeout(10000,()=>{req.destroy();res({err:"timeout"})});
    req.on("error",e=>res({err:String(e.message).slice(0,26)}));
    req.end();
  });
}
(async()=>{
  const qs=process.argv.slice(2);
  let ok=0,bad=0,inline=0;const fails=[];
  for(const q of qs){
    let a;try{a=await p.search(q,1,"music")}catch(e){fails.push(q+" SEARCH "+e.message.slice(0,50));continue}
    for(const t of (a.data||[]).slice(0,4)){
      let r;try{r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard")}
      catch(e){bad++;fails.push(t.platform+"/"+t.title.slice(0,12)+" ERR "+e.message.slice(0,40));continue}
      const u=String(r.url||"");
      if(u.startsWith("data:")){inline++;ok++;continue}
      const v=await probe(u,r.headers||{});
      if(v.kind)ok++;else{bad++;fails.push(t.platform+"/"+t.title.slice(0,14)+" "+v.code+" nokind");}
    }
  }
  console.log("RESULT ok="+ok+" bad="+bad+" inline="+inline);
  fails.forEach(f=>console.log("  -",f));
  process.exit(0);
})().catch(e=>{console.log("FATAL",e&&e.stack);process.exit(1)});
