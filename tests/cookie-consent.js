const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const U='http://localhost:8765/';
for (const [w,h,t] of [[1366,900,'d'],[390,844,'m']]){
const ctx=await b.newContext({viewport:{width:w,height:h}});const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto(U+'index.html');await p.waitForSelector('.cc-banner.is-visible');await p.waitForTimeout(400);await p.screenshot({path:`screenshots/cc-banner-${t}.png`});
await p.click('[data-cc=manage]');await p.waitForSelector('dialog.cc-dialog[open]');await p.screenshot({path:`screenshots/cc-dialog-${t}.png`});
await p.check('[data-cat=preferences]');await p.click('[data-cc=save]');
let ck=(await ctx.cookies()).find(c=>c.name==='bv_consent');console.log(t,'cookie',decodeURIComponent(ck.value));
await p.goto(U+'pricing.html');console.log(t,'banner after save:',await p.locator('.cc-banner').count());
await p.fill('#calc-contacts','777');await p.fill('#calc-rate','0.2');await p.goto(U+'pricing.html');console.log(t,'remembered contacts',await p.inputValue('#calc-contacts'),await p.inputValue('#calc-rate'));
await p.click('.footer-linkbtn');await p.click('[data-cc=reject-all]');console.log(t,'pref storage after reject',await p.evaluate(()=>localStorage.getItem('bv.pref.calculator')));
await p.goto(U+'pricing.html');console.log(t,'after reject contacts',await p.inputValue('#calc-contacts'));
await p.goto(U+'cookies.html');await p.screenshot({path:`screenshots/cookies-${t}.png`,fullPage:true});
const o=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);console.log(t,'overflow',o,errs);await ctx.close();}
// GPC
const ctx=await b.newContext();await ctx.addInitScript(()=>Object.defineProperty(navigator,'globalPrivacyControl',{get:()=>true}));
const p=await ctx.newPage();await p.goto(U+'index.html');await p.click('[data-cc=accept]');console.log('gpc',decodeURIComponent((await ctx.cookies())[0].value));
await b.close();})();
