const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const U='http://localhost:8765/dashboard.html';
const ctx=await b.newContext({viewport:{width:1366,height:900}});await ctx.addCookies([{name:'bv_consent',value:encodeURIComponent(JSON.stringify({v:'2026-10',necessary:true,preferences:false,analytics:false})),url:'http://localhost:8765'}]);
const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));p.on('dialog',d=>d.accept());
await p.goto(U+'#/groups');await p.click('#g-empty-new');await p.fill('#g-name','Excel test');await p.click('#g-new button[type=submit]');await p.waitForSelector('#imp-file');
for (const f of ['t6.xlsx','t1.xlsx','t2.xlsx','t3.xlsx','t4.xls','t5.xlsx']){await p.setInputFiles('#imp-file',f);await p.waitForTimeout(700);console.log(f,'→',await p.textContent('#imp-result'));}
const data=await p.evaluate(()=>JSON.parse(localStorage.getItem('balvoice.demo.v1')).contacts);
const show=ph=>JSON.stringify(data.find(c=>c.p===ph));
console.log(show('233240000005'),show('+233205550007'),show('+233261110002'),show('0244123456'));
console.log('total',data.length,'other-sheet leaked:',!!data.find(c=>c.p==='+233999999999'));
await p.screenshot({path:'screenshots/xl-group.png'});
// wizard upload path
await p.goto(U+'#/new');await p.fill('#w-name','Excel campaign');await p.selectOption('#w-type','church');await p.fill('#w-sender','Grace');await p.click('button[type=submit]');
await p.setInputFiles('#w-audio','msg.wav');await p.waitForSelector('#audio-remove');await p.check('#w-chk-sender');await p.check('#w-chk-optout');await p.click('button[type=submit]');
await p.click('[data-value=upload]');await p.setInputFiles('#w-list','t1.xlsx');await p.waitForSelector('#list-remove');
console.log('wizard grid',(await p.$$eval('.check-grid .v',e=>e.map(x=>x.textContent))).join(' | '));
await p.screenshot({path:'screenshots/xl-wizard.png',fullPage:true});
console.log('errors',errs);await b.close();})();
