const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const pages = ['index','church','political','how-it-works','pricing','about','contact','404','cookies','privacy'];
  for (const [w,h,tag] of [[1366,900,'d'],[390,844,'m']]) {
    const ctx = await b.newContext({ viewport:{width:w,height:h} });
    const p = await ctx.newPage();
    const errs=[]; p.on('console', m=>{ if(m.type()==='error' && !/fonts\.g/.test(m.text())) errs.push(m.text())}); p.on('pageerror', e=>errs.push(e.message));
    for (const n of pages) {
      await p.goto(`http://localhost:8765/${n}.html`, {waitUntil:'load'});
      await p.evaluate(()=>document.querySelectorAll('.reveal').forEach(e=>e.classList.add('is-visible')));
      await p.waitForTimeout(1300);
      const overflow = await p.evaluate(()=>document.documentElement.scrollWidth > window.innerWidth);
      if (overflow) errs.push(`${n} horizontal overflow at ${w}`);
      await p.screenshot({path:`screenshots/${n}-${tag}.png`, fullPage:true});
    }
    console.log(tag, errs);
    await ctx.close();
  }
  await b.close();
})();
