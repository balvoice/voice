# Cookie consent

## What the visitor sees

1. **First visit:** a banner at the bottom of the screen with **Reject non-essential**, **Accept all** (equal size and style), **Manage preferences**, and a link to the cookie policy. Nothing optional is stored until they choose.
2. **Manage preferences:** an accessible dialog with one switch per category:
   - **Strictly necessary:** always on.
   - **Preferences:** the pricing calculator remembers your inputs.
   - **Analytics:** declared, but not in use yet.
3. **Later changes:** "Cookie settings" in every footer (and in the dashboard sidebar) reopens the dialog. The cookie policy page has a button too.
4. **Global Privacy Control:** if the browser sends GPC, the banner says so and analytics stays off, even after "Accept all".

## How it works

- The choice is stored in a first-party cookie, `bv_consent` (180 days, `SameSite=Lax`, `Secure` on HTTPS):
  `{"v":"2026-10","necessary":true,"preferences":false,"analytics":false,"ts":"…","gpc":false}`
- `POLICY_VERSION` in `src/assets/js/consent.js` must match `v`. **Change it whenever the cookie policy changes**, and everyone is asked again.
- Withdrawing Preferences deletes every `localStorage` key that starts with `bv.pref.`.

## Using consent in code

```js
if (window.BalVoiceConsent && BalVoiceConsent.has("preferences")) { /* store something */ }
BalVoiceConsent.onChange(consent => { /* react to a new choice */ });
BalVoiceConsent.open();   // open the dialog
BalVoiceConsent.reset();  // forget the choice (testing)
```

## Adding analytics later

1. Add the script tag in a page or partial, **blocked** until consent:
   ```html
   <script type="text/plain" data-consent="analytics" data-src="https://analytics.example.com/script.js"></script>
   ```
   `consent.js` loads it only after Analytics is allowed.
2. Allow the analytics domain in the Content Security Policy (`src/partials/head.html` and `src/static/_headers`): `script-src` and `connect-src`.
3. Update the Analytics row in `src/pages/cookies.html` with each cookie's name, purpose, and duration.
4. Change the Analytics description in `consent.js` (remove "Not currently in use").
5. Bump `POLICY_VERSION` so existing visitors are asked again.

## Recommendations before launch

- **Self-host the fonts.** Google Fonts sends visitor IP addresses to Google. Download IBM Plex (it is open source) into `src/assets/fonts/`, replace the Google Fonts link with local `@font-face` rules, and remove `fonts.googleapis.com` / `fonts.gstatic.com` from the CSP. The cookie policy section on third parties can then be removed.
- **Keep a consent log** on the server if you add analytics or marketing tools (timestamp, policy version, choice, anonymized identifier).
- **Have a legal adviser review** `cookies.html` and `privacy.html` and fill in the placeholders.
