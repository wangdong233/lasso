const rxMain = /^\s*(课前必读|\d{2})\s*[|｜]/;
const rxJiang = /[（(]\s*\d+\s*讲\s*[)）]/;
const hits = [];
for (const el of document.querySelectorAll('body *')) {
  if (hits.length >= 12) break;
  const own = Array.from(el.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
  if (!own) continue;
  if (rxMain.test(own) || rxJiang.test(own)) {
    const path = [];
    let p = el;
    for (let i=0;i<4 && p;i++){ const c=(typeof p.className==='string'&&p.className)?'.'+p.className.trim().split(/\s+/).slice(0,2).join('.') : (p.getAttribute&&p.getAttribute('class')?'.'+String(p.getAttribute('class')).split(/\s+/).slice(0,2).join('.'):''); path.push(p.tagName.toLowerCase()+c); p=p.parentElement; }
    hits.push({t: own.slice(0,36), tag: el.tagName.toLowerCase(), id: el.id||'', path: path.join('<').slice(0,200)});
  }
}
return JSON.stringify({n:hits.length, hits});
