const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();
for (const [w,h,t] of [[1366,900,'d'],[390,844,'m']]){
const ctx=await b.newContext({viewport:{width:w,height:h}});await ctx.addCookies([{name:'bv_consent',value:encodeURIComponent(JSON.stringify({v:'2026-10',necessary:true,preferences:false,analytics:false})),url:'http://localhost:8765'}]);const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('console',m=>{if(m.type()==='error'&&!/TUNNEL/.test(m.text()))errs.push(m.text())});
p.on('dialog',d=>d.accept());
await p.goto('http://localhost:8765/dashboard.html');await p.screenshot({path:`screenshots/dash-empty-${t}.png`});
await p.goto('http://localhost:8765/dashboard.html#/optouts');await p.fill('#o-phone','+233241000005');await p.click('#optout-form button');
await p.goto('http://localhost:8765/dashboard.html#/new');
await p.fill('#w-name','Easter convention');await p.selectOption('#w-type','church');await p.fill('#w-sender','Grace Chapel');await p.click('button[type=submit]');
await p.setInputFiles('#w-audio','msg.wav');await p.waitForSelector('#audio-remove');await p.check('#w-chk-sender');await p.check('#w-chk-optout');await p.click('button[type=submit]');
await p.setInputFiles('#w-list','list.csv');await p.waitForSelector('#list-remove');await p.screenshot({path:`screenshots/dash-list-${t}.png`,fullPage:true});await p.check('#w-consent');await p.fill('#w-basis','Members gave their numbers on the registration form');await p.click('button[type=submit]');
await p.fill('#w-date','2027-01-10');await p.fill('#w-time','10:00');await p.click('button[type=submit]');
await p.click('button[type=submit]');await p.waitForSelector('[data-act=start]');await p.click('[data-act=start]');
await p.waitForSelector('[data-act=export]',{timeout:20000});await p.screenshot({path:`screenshots/dash-detail-${t}.png`,fullPage:true});
const ov=await p.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1 && !e.closest('.table-wrap') && !e.closest('.sidebar')).slice(0,6).map(e=>e.tagName+'.'+e.className+' '+Math.round(e.getBoundingClientRect().right)));
await p.goto('http://localhost:8765/dashboard.html#/campaigns');await p.screenshot({path:`screenshots/dash-list-view-${t}.png`});
console.log(t,errs,'overflow',ov);await p.close();}
await b.close();})();
