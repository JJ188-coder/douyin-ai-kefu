const PORT=9223; const DURATION=Number(process.env.DURATION||180);
(async()=>{ const start=Date.now(); const seen=new Set();
 while(Date.now()-start<DURATION*1000){ try{
   const list=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();
   const page=list.find(t=>t.type==='page'&&t.url.includes('life.douyin.com/cs'));
   if(!page){await new Promise(r=>setTimeout(r,2500));continue;}
   const ws=new WebSocket(page.webSocketDebuggerUrl); let mid=0; const pend=new Map();
   const send=(m,p={})=>new Promise(res=>{const id=++mid;pend.set(id,res);ws.send(JSON.stringify({id,method:m,params:p}));});
   ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}};
   await new Promise(res=>{ws.onopen=res; setTimeout(res,4000);});
   const r=await send('Runtime.evaluate',{expression:'JSON.stringify(window.__s4||[])',returnByValue:true});
   const arr=r.result?.result?.value?JSON.parse(r.result.result.value):[];
   for(const it of arr){const k=JSON.stringify(it); if(!seen.has(k)){seen.add(k);console.log(JSON.stringify(it));}}
   ws.close(); }catch(e){}
   await new Promise(r=>setTimeout(r,2500));
 } console.log('POLL_DONE'); process.exit(0); })();
