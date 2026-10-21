const p=require("./v23.js");
(async()=>{
  const d=await p.getAlbumInfo({id:"mbal:4fe422e3-90aa-459c-a6a7-a7c6da78a9fb",platform:"MusicBrainz",title:"双",artist:"赵薇",_provider:"mb",_kind:"album"},1);
  if(!d){console.log("NULL");return;}
  const l=d.musicList||[];
  console.log("v4.10.23 worksNum",d.albumItem.worksNum,"musicList",l.length);
  l.forEach((m,i)=>console.log("  ",i+1,m.title,"|",m.platform));
})();
