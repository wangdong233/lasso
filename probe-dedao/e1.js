return JSON.stringify({url: location.href, title: document.title, ready: document.readyState, textHead: (document.body?.innerText||'').replace(/\n+/g,'|').slice(0,500)});
