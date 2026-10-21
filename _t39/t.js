const p=require('./z.js');
const s=()=>Date.now();
(async()=>{
  console.log('ver='+p.version);
  const t0=s();
  let q=await p.search('赵薇',1,'artist');
  console.log('search '+(s()-t0)+'ms n='+q.data.length+' item='+JSON.stringify(q.data[0]&&{id:q.data[0].id,n:q.data[0].name,keys:Object.keys(q.data[0])}));
  const a=q.data[0]; if(!a) return;
  for(const type of ['music','album']){
    for(let pg=1;pg<=3;pg++){
      const t=s(); let r=null,e='';
      try{ r=await Promise.race([p.getArtistWorks(a,pg,type),new Promise(rr=>setTimeout(()=>rr('TO'),45000))]); }catch(x){e=x.message}
      console.log(type+' p'+pg+' '+(s()-t)+'ms '+(r==='TO'?'>>>45s 卡死':'n='+(r.data||[]).length+' end='+r.isEnd)+' '+e);
    }
  }
  process.exit(0);
})();
