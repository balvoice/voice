const { chromium } = require('playwright');
const CONSENT = { name: 'bv_consent', value: encodeURIComponent(JSON.stringify({ v: '2026-10', necessary: true, preferences: false, analytics: false })) };
function fakeJwt(sub) { const b = o => Buffer.from(JSON.stringify(o)).toString('base64url'); return b({ alg: 'HS256', typ: 'JWT' }) + '.' + b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, aud: 'authenticated' }) + '.sig'; }
function session(user) { return { access_token: fakeJwt(user.id), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r1', user }; }
const userEmail = { id: '11111111-1111-1111-1111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'ama@example.org', phone: '', app_metadata: { provider: 'email' }, user_metadata: { full_name: 'Ama Mensah' }, created_at: new Date().toISOString() };
const userPhone = { ...userEmail, id: '22222222-2222-2222-2222-222222222222', email: '', phone: '233241234567', user_metadata: { full_name: 'Kofi Boateng' } };
(async () => {
  const b = await chromium.launch(); const log = [];
  // ---- Demo mode (no Supabase settings)
  {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } }); await ctx.addCookies([{ ...CONSENT, url: 'http://localhost:8765' }]);
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto('http://localhost:8765/login.html'); await p.waitForTimeout(400);
    log.push(['demo: login notice', (await p.textContent('#auth-alert')).slice(0, 60)]);
    await p.click('[data-oauth]'); log.push(['demo: google click blocked', (await p.textContent('#auth-alert')).includes('not connected')]);
    await p.screenshot({ path: 'screenshots/auth-login-demo-d.png' });
    await p.goto('http://localhost:8765/dashboard.html'); await p.waitForTimeout(500);
    log.push(['demo: dashboard open', await p.isVisible('.app-shell'), await p.textContent('[data-auth-status]')]);
    log.push(['demo errors', errs.join('|') || 'none']); await ctx.close();
  }
  // ---- Mock Supabase
  for (const [w, h, t] of [[1366, 900, 'd'], [390, 844, 'm']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } }); await ctx.addCookies([{ ...CONSENT, url: 'http://localhost:8766' }]);
    const calls = [];
    await ctx.route('https://test.supabase.co/**', async route => {
      const r = route.request(); const u = new URL(r.url()); const body = r.postDataJSON ? (() => { try { return r.postDataJSON(); } catch { return null; } })() : null;
      calls.push(r.method() + ' ' + u.pathname + u.search.replace(/code_challenge=[^&]+/, 'code_challenge=…') + (body ? ' ' + JSON.stringify(body).replace(/"captcha_token":null,?/, '').slice(0, 140) : ''));
      const json = (status, obj) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
      if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password')
        return body.password === 'Correct-Horse-9' ? json(200, session(userEmail)) : json(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      if (u.pathname === '/auth/v1/otp') return json(200, {});
      if (u.pathname === '/auth/v1/verify') return body.token === '123456' ? json(200, session(userPhone)) : json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      if (u.pathname === '/auth/v1/signup') return json(200, { ...userEmail, email: body.email, identities: [], confirmation_sent_at: new Date().toISOString() });
      if (u.pathname === '/auth/v1/recover') return json(200, {});
      if (u.pathname === '/rest/v1/staff') return json(200, [{ role: 'admin', active: true }]);
      if (u.pathname === '/auth/v1/user') return json(200, userEmail);
      if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
      if (u.pathname === '/auth/v1/authorize') return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Google consent (mock)</h1>' });
      return json(404, { msg: 'not mocked' });
    });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    const U = 'http://localhost:8766/';
    // Dashboard guard redirects when signed out
    await p.goto(U + 'dashboard.html#/groups', { waitUntil: 'commit' }).catch(() => {}); await p.waitForURL(/login\.html/, { waitUntil: 'domcontentloaded' }).catch(() => {}); await p.waitForSelector('#li-email'); log.push([t, 'guard redirect', p.url().replace(U, '')]);
    // Email: wrong then right password
    await p.fill('#li-email', 'ama@example.org'); await p.fill('#li-password', 'wrong'); await p.click('#panel-email [type=submit]');
    await p.waitForSelector('#auth-alert.is-error'); log.push([t, 'wrong password', await p.textContent('#auth-alert')]);
    await p.screenshot({ path: `screenshots/auth-login-error-${t}.png`, fullPage: true });
    await p.fill('#li-password', 'Correct-Horse-9'); await p.click('#panel-email [type=submit]');
    await p.waitForURL(/dashboard\.html/); await p.waitForSelector('.avatar-btn'); log.push([t, 'email login →', p.url().replace(U, ''), await p.textContent('.avatar-btn'), await p.textContent('[data-auth-status]')]);
    await p.click('.avatar-btn'); await p.screenshot({ path: `screenshots/auth-dash-menu-${t}.png` });
    await p.click('.user-signout'); await p.waitForURL(/login\.html/, { waitUntil: 'domcontentloaded' }); await p.waitForSelector('#li-email'); log.push([t, 'sign out →', p.url().replace(U, '')]);
    // Phone login
    await p.click('#tab-phone'); await p.fill('#lp-phone', '024 123 4567'); await p.click('#panel-phone [data-step=phone] [type=submit]');
    await p.waitForSelector('#panel-phone [data-step=code]:not([hidden])'); log.push([t, 'phone shown as', await p.textContent('[data-phone-display]'), 'resend disabled', await p.isDisabled('[data-resend]')]);
    await p.screenshot({ path: `screenshots/auth-phone-code-${t}.png`, fullPage: true });
    await p.fill('#lp-code', '999999'); await p.click('#panel-phone [data-step=code] [type=submit]'); await p.waitForSelector('#auth-alert.is-error');
    log.push([t, 'wrong code', await p.textContent('#auth-alert')]);
    await p.fill('#lp-code', '123456'); await p.click('#panel-phone [data-step=code] [type=submit]'); await p.waitForURL(/dashboard\.html/); await p.waitForSelector('.avatar-btn');
    log.push([t, 'phone login →', p.url().replace(U, ''), await p.textContent('.avatar-btn')]);
    await p.evaluate(() => localStorage.clear());
    // Invalid phone
    await p.goto(U + 'login.html?method=phone'); await p.fill('#lp-phone', '12345'); await p.click('#panel-phone [data-step=phone] [type=submit]');
    log.push([t, 'invalid phone', await p.textContent('#panel-phone .field-error')]);
    // Sign-up is closed: the old page explains that accounts are by invitation
    await p.goto(U + 'signup.html');
    log.push([t, 'signup page', (await p.textContent('h1')).trim(), '| forms:', await p.locator('form').count()]);
    log.push([t, 'login has no sign-up link', await p.locator('a[href="signup.html"]').count() === 0]);
    // Forgot password
    await p.goto(U + 'forgot-password.html'); await p.fill('#fp-email', 'nobody@example.org'); await p.click('[data-form=forgot] [type=submit]'); await p.waitForSelector('#auth-alert.is-success');
    log.push([t, 'forgot', (await p.textContent('#auth-alert')).slice(0, 60)]);
    // Google
    await p.goto(U + 'login.html?next=dashboard.html%23/groups'); await p.click('[data-oauth=google]'); await p.waitForURL(/authorize/);
    const au = new URL(p.url()); log.push([t, 'google →', au.pathname, au.searchParams.get('provider'), 'redirect_to', au.searchParams.get('redirect_to'), 'pkce', !!au.searchParams.get('code_challenge')]);
    // Open-redirect protection
    await p.goto(U + 'login.html?next=https://evil.example/steal'); await p.click('#tab-email'); await p.fill('#li-email', 'ama@example.org'); await p.fill('#li-password', 'Correct-Horse-9'); await p.click('#panel-email [type=submit]');
    await p.waitForURL(u => /dashboard\.html|evil\.example\/steal$/.test(u.pathname + u.host + u.pathname)); log.push([t, 'open redirect attempt lands on', p.url().replace(U, '')]);
    // Reset page with bad link
    await p.waitForTimeout(800); await p.goto(U + 'cookies.html'); await p.evaluate(() => localStorage.clear()); await p.goto(U + 'reset-password.html'); await p.waitForTimeout(800); log.push([t, 'reset w/o link', await p.textContent('[data-reset-intro]')]);
    const o = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    log.push([t, 'overflow', o, 'errors', errs.filter(e => !/TUNNEL|ERR_|404|Failed to load/.test(e)).join(' | ') || 'none']);
    log.push([t, 'API calls', '\n   ' + calls.filter(c => !/\/user$/.test(c)).join('\n   ')]);
    await ctx.close();
  }
  log.forEach(l => console.log(l.join(' ')));
  await b.close();
})();
