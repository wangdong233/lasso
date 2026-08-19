const mods=document.querySelectorAll('div.chapter-mod');
const tree=[];
mods.forEach((m,i)=>{
  if(i>6) return;
  const h=m.querySelector(':scope > .chapterp-header');
  const lis=[...m.querySelectorAll('ul.course-module > li')];
  tree.push({i,header:(h?.innerText||'').replace(/\n+/g,' ').slice(0,44),liRendered:lis.length,liTotal:m.querySelectorAll('li').length,
    first:lis.slice(0,3).map(li=>(li.querySelector('.article-list-title')?.innerText||'').slice(0,26)),
    liAttrs:lis[0]?{class:String(lis[0].className).slice(0,60),dataset:Object.keys(lis[0].dataset||{}).map(k=>k+'='+String(li.dataset[k]).slice(0,14)).slice(0,4)}:null,
    liSel:lis.map((li,j)=>String(li.className).match(/active|current|select/)?j:-1).filter(j=>j>=0)});
});
return JSON.stringify({chapterMods:mods.length,tree});
