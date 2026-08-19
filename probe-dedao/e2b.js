const out=[];
const tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
let n;
while((n=tw.nextNode())&&out.length<14){
  const t=(n.textContent||'').trim();
  if(!t) continue;
  if(/课前必读/.test(t)||/[（(]\d+讲[)）]/.test(t)||/^\d{2}$/.test(t)||/^第\d+讲/.test(t)||/^发刊词/.test(t)){
    const el=n.parentElement;
    const path=[];let p=el;
    for(let i=0;i<5&&p;i++){const c=(typeof p.className==='string'&&p.className)?'.'+p.className.trim().split(/\s+/).slice(0,2).join('.'):(p.id?'#'+p.id:'');path.push(p.tagName.toLowerCase()+c);p=p.parentElement;}
    out.push({t:t.slice(0,30),tag:el.tagName.toLowerCase(),cls:String(el.className).slice(0,50),path:path.join('<').slice(0,230)});
  }
}
return JSON.stringify({n:out.length,out});
