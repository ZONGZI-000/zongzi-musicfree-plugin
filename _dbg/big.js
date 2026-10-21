global.env={userVariables:{}};
const p=require("D:/workspace/zongzi-musicfree-plugin/zongzimusic.js");
const https=require("https"),{URL}=require("url");
function req(url,headers){
  return new Promise(res=>{
    const u=new URL(url);const t0=Date.now();
    const r=https.request({hostname:u.hostname,path:u.pathname+u.search,port:443,method:"GET",headers},x=>{
      let n=0,b=Buffer.alloc(0);
      x.on("data",c=>{n+=c.length;if(b.length<16)b=Buffer.concat([b,c]).slice(0,16);if(n>=1024){r.destroy();fin()}});
      x.on("end",fin);
      function fin(){const bb=b;let k=null;
        if(bb[0]===0x49&&bb[1]===0x44&&bb[2]===0x33)k="ID3";
        else if(bb[4]===0x66&&bb[5]===0x74)k="MP4";
        else if(bb[0]===0x1a&&bb[1]===0x45)k="WEBM";
        res({code:x.statusCode,n,kind:k,ms:Date.now()-t0,body:k?null:bb.toString("utf8").slice(0,80).replace(/\n/g," ")});}
    });
    r.setTimeout(15000,()=>{r.destroy();res({err:"timeout"})});
    r.on("error",e=>res({err:String(e.message).slice(0,26)}));
    r.end();
  });
}
(async()=>{
  let n=0;
  for(const q of ["周杰伦 晴天","Adele","Coldplay","Taylor Swift"]){
    const a=await p.search(q,1,"music");
    for(const t of (a.data||[]).filter(x=>x.platform==="YouTube")){
      const s=Date.now();
      let r;try{r=await p.getMediaSource(JSON.parse(JSON.stringify(t)),"standard")}catch(e){continue}
      const u=String(r.url||"");
      if(u.startsWith("data:"))continue;   // 内联的跳过，只看必须走流式的
      n++;
      const v=await req(u,{});
      console.log(t.title.slice(0,26),"|",new URL(u).host.slice(0,26),"|",v.kind?"OK "+v.kind:(v.code||v.err),"|",v.ms+"ms");
      if(n>=6)break;
    }
    if(n>=6)break;
  }
  console.log("stream-only entries tested:",n);
  process.exit(0);
})().catch(e=>{console.log("FATAL",e.message);process.exit(1)});
