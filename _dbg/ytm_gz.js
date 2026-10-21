const axios=require("axios");
(async()=>{
  const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36";
  for(const [name,hdr] of [
    ["plain",{ "User-Agent":UA }],
    ["gz",{ "User-Agent":UA, "Accept-Encoding":"gzip, deflate, br" }],
  ]){
    const t0=Date.now();
    try{
      const r=await axios.get("https://music.youtube.com/",{timeout:20000,responseType:"text",transformResponse:[x=>x],headers:hdr,validateStatus:()=>true});
      console.log(name,"| status",r.status,"| bytes",Buffer.byteLength(String(r.data||"")),"|",Date.now()-t0+"ms","| enc:",r.headers["content-encoding"]||"-");
      const d=String(r.data||"");
      console.log("   key:",(d.match(/"INNERTUBE_API_KEY":"([^"]+)"/)||[])[1]||"MISSING",
                  "| ver:",(d.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)||[])[1]||"MISSING",
                  "| visitor:",((d.match(/"VISITOR_DATA":"([^"]+)"/)||[])[1]||"MISSING").slice(0,20));
    }catch(e){console.log(name,"ERR",e.message.slice(0,80));}
  }
  process.exit(0);
})();
