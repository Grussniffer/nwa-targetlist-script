# NWA Target Finder

Find chain targets for **North West Alliance**.

## Install

[**Install NWA Target Finder**](https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/codex/initial/dist/torn-targetlist.user.js)

### Tampermonkey

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Click the **Install NWA Target Finder** link above and confirm **Install** in Tampermonkey.
3. Reload Torn.

On Chrome, enable **Allow User Scripts** in Tampermonkey's extension settings ([help](https://www.tampermonkey.net/faq.php?ext=dhdg&q=Q209)).

![Chrome Allow User Scripts switch enabled in Tampermonkey's official help screenshot](docs/images/tampermonkey-allow-user-scripts.png)

*Chrome screenshot from [Tampermonkey's official help](https://www.tampermonkey.net/faq.php?ext=dhdg&q=Q209).*

### Torn PDA

1. Open **Settings → Advanced Browser Settings** and turn on **Enable custom user scripts**.
2. Open **Manage scripts → +**. Tap **Configure** beside **Remote load/update**, and enter this link in **Remote URL**:

   ```text
   https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/codex/initial/dist/torn-targetlist.user.js
   ```

3. Tap **Fetch → Load**, choose **Continue** if permissions appear, and reload Torn inside PDA.

Keep the script enabled on all Torn pages. NWA includes PDA support and remembers your login and settings. Newer PDA versions use the app's script storage, which survives clearing the browser cache; older versions use browser storage. Sign in through NWA's key-use notice as usual.

## Start

Open Torn and click the green **NWA** button on the right edge. Sign in with your **Limited Torn API key** the first time.

NWA prepares targets in the background. Click **NWA** to find an available target within your stat range. It reserves the target for 60 seconds to reduce other NWA members choosing the same player, and skips players you opened in the last 10 minutes. You start the attack yourself. The finder tries up to five matches within eight seconds.

The small **⚙** underneath opens settings, the target list, and suggestions. Set **Min** and **Max** target stats as percentages of your own total; NWA only picks targets within that range. The default is **10–60%**, with the equivalent stat totals shown underneath. Your settings are saved between pages, and your existing maximum is kept when updating. Set **Min** to **0%** to include weaker targets.

**Maximum estimate age** defaults to **7 days**. You can allow older estimates, up to 365 days; older estimates can be inaccurate, especially beyond 28 days. Refreshing the list may still return the same old FFScouter estimate. The list shows how many targets are ready, too old, or missing stats. **Clear recent targets** lets you choose recently opened players again.

<img src="docs/images/nwa-controls.png" width="720" alt="Actual NWA controls with arrows: NWA finds a target and the gear underneath opens settings">

<img src="docs/images/nwa-login.png" width="720" alt="Actual NWA sign-in panel: read the key storage notice, enter your Limited Torn API key and tap Sign in and save key">

The backend is already set to [targetlist.grusmedia.no](https://targetlist.grusmedia.no). You only need your Torn key.

## Use

- **Targets:** browse the list, search players/factions/reasons, or filter by estimated stats. **Possible matches** applies your minimum, maximum and estimate-age limit.
- **Check status:** check a target before opening its attack page.
- **Profiles and attack pages:** listed players show a small NWA chip with their saved reason. Tap or click it to read the full reason. This appears after your session and target list have loaded, including for targets outside your stat range.
- **Suggestions:** suggest a player or faction with a required comment.
- **Approvals:** faction leaders and co-leaders can approve or reject suggestions.

Your Limited key verifies your name and faction and reads your battle stats. We save it **encrypted in Supabase with an expiry of up to 7 days** so NWA can refresh hospital status and target faction rosters while you are offline. Status checks run every **30 seconds**, prioritizing usable targets and hospital releases within a limit per player. Faction rosters refresh every five minutes when a usable key is available. **Sign out and remove key** deletes your saved key and logins. The script saves a session token; a hash is stored by the backend so your login survives restarts until its original expiry. A new sign-in replaces your previous login. The first update to persistent logins requires signing in once.

Only allowed factions can use the list. Instant selection requires an availability check under 30 seconds old. A target can still enter hospital after a check. Battle stats are estimates; attacks are manual.

Disable any separate old **Torn Faction Target List** entry. Your installed version appears in the settings header.
