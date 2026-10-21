const axios=require("axios");
(async()=>{
  const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36";
  for(const [n,h] of [["default",{"User-Agent":UA}],["gz",{"User-Agent":UA,"Accept-Encoding":"gzip, deflate, br"}]]){
    const r=await axios.get("https://music.youtube.com/",{timeout:20000,responseType:"text",transformResponse:[x=>x],headers:h,validateStatus:()=>true});
    console.log(n,"| content-length header:",r.headers["content-length"],"| encoding:",r.headers["content-encoding"]||"-","| decoded:",Buffer.byteLength(String(r.data||"")));
  }
  process.exit(0);
})();
