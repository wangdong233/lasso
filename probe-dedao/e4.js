function pathOf(el,d){const p=[];let x=el;for(let i=0;i<d&&x;i++){const c=(typeof x.className==='string'&&x.className)?'.'+x.className.trim().split(/\s+/).slice(0,2).join('.'):'';p.push(x.tagName.toLowerCase()+c);x=x.parentElement;}return p.join('<');}
const out={};
const tw=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;const fp=[];
while((n=tw.nextNode())){const t=(n.textContent||'').trim();if(/^首次发布$/.test(t)){const el=n.parentElement;fp.push({t,tag:el.tagName.toLowerCase(),cls:String(el.className).slice(0,40),path:pathOf(el,6)});if(fp.length>=3)break;}}
out.firstPublish=fp;
out.audio={n:document.querySelectorAll('audio').length,paths:[...document.querySelectorAll('audio')].slice(0,2).map(a=>pathOf(a,4))};
out.h1=[...document.querySelectorAll('h1,h2,h3')].slice(0,6).map(h=>({tag:h.tagName,txt:(h.innerText||'').slice(0,30),path:pathOf(h,4)}));
const imgs=[...document.querySelectorAll('img')];
out.imgs={n:imgs.length,first5:imgs.slice(0,5).map(im=>({src:(im.currentSrc||im.src||'').slice(0,60),w:im.width,h:im.height,cls:String(im.className).slice(0,30)}))};
out.classes={article:document.querySelectorAll('[class*="article-"]').length,main:[...document.querySelectorAll('main,[class*="article-main"],[class*="detail"]')].slice(0,4).map(e=>({tag:e.tagName,cls:String(e.className).slice(0,50)}))};
return JSON.stringify(out).slice(0,3800);
