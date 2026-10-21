const p = require("./v24.js");
const crypto=require("crypto");
(async()=>{
  const d = await p.getAlbumInfo({id:"mbal:4fe422e3-90aa-459c-a6a7-a7c6da78a9fb",platform:"MusicBrainz",title:"双",artist:"赵薇",_provider:"mb",_kind:"album"},1);
  const list=d.musicList||[];
  console.log("v24 list", list.length);
  for(const idx of [0,2,6,8]){
    const m=list[idx];
    try{const r=await p.getMediaSource(m,"standard");const s=String(r.url||"");
      console.log("OK",idx+1,m.title,"len",s.length,"md5",crypto.createHash("md5").update(s.slice(0,100000)).digest("hex").slice(0,8));}
    catch(e){console.log("FAIL",idx+1,m.title,e.message.slice(0,100));}
  }
})();
