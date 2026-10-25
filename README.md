# NWA Target Finder

Find chain targets for **North West Alliance**.

## Install

[**Install NWA Target Finder**](https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/main/dist/torn-targetlist.user.js)

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
   https://raw.githubusercontent.com/Grussniffer/nwa-targetlist-script/main/dist/torn-targetlist.user.js
   ```

3. Tap **Fetch → Load**, choose **Continue** if permissions appear, and reload Torn inside PDA.

If your existing PDA **Remote URL** contains `codex/initial`, change it to the `main` link above so it receives future updates.

Keep the script enabled on all Torn pages. NWA includes PDA support and remembers your login and settings. Newer PDA versions use the app's script storage, which survives clearing the browser cache; older versions use browser storage. Sign in through NWA's key-use notice as usual.

## Start

Open Torn and click the green **NWA** button on the right edge. Sign in with your **Limited Torn API key** the first time.

NWA prepares targets in the background. Click **NWA** to find an available target within your stat range. With backend 0.9.0 or later, the server chooses and reserves a target in one request. The backend holds each assignment for **two minutes**, including earlier targets when you open another one. Your browser also skips players you opened in the last 10 minutes. You start the attack yourself. Older backends keep the existing coordinated finder and show an update notice. If target coordination is unavailable, NWA asks you to refresh instead of opening an unreserved target. Ordinary Torn links, including those in exports, do not acquire a reservation.

The small **⚙** underneath opens the compact target list and suggestions. **Find target** in the panel works like the green NWA button. Search and **Min / Max** stay above the list; each row shows the player's estimated stats, percentage of your total, availability and attack controls. On Torn PDA, the panel opens nearly full width.

Keyboard users can open settings with **Enter**, move through controls with **Tab**, and press **Escape** to close settings and return to the button that opened it. Focus stays in place when sections change or target rows update.

Large lists load more rows as you scroll, with **Show more** available when needed. Search, counts and exports still cover the complete matching list. The panel opens immediately; background refreshing slows while idle and resumes promptly when you use NWA. Temporary connection failures retry with a delay without clearing your login.

Set **Min** and **Max** as percentages of your own total. The default is **10–60%**, with the equivalent stat totals shown underneath. Your range is saved between pages. Set **Min** to **0%** to include weaker targets.

Open **Preferences & account** below the targets, or use **⋯** in the header, for your detailed battle stats, estimate-age limit, exports and **Sign out and remove key**. **Maximum estimate age** defaults to **7 days**; older estimates can be inaccurate. **Clear recent targets** lets you choose recently opened players again. Tap the **ready / shown** count for fuller pool diagnostics.

<img src="docs/images/nwa-controls.png" width="720" alt="Actual NWA controls with arrows: NWA finds a target and the gear underneath opens settings">

The backend is already set to [targetlist.grusmedia.no](https://targetlist.grusmedia.no). You only need your Torn key.

## Use

- **Targets:** browse the list, search players/factions/reasons, or filter by estimated stats. **Possible matches** applies your minimum, maximum and estimate-age limit.
- **Check status:** refresh availability. Ready targets offer **Attack**; reserved, stale and unavailable targets are labelled in the row.
- **Export:** open **Preferences & account**, choose **All targets** or **Shown targets**, then **Export CSV** or **Export Markdown**. Download the file or use **Copy export**; the preview also supports manual text selection in Torn PDA. Exports include estimates, factions, reasons, status timestamps and Torn links.
- **Profiles and attack pages:** a small NWA badge shares the FairFight line, or the player's name/title line when FFScouter is absent or there is no room. It shows estimated battle stats without adding a row. Tap it for the full reason, estimate source and age. FFScouter is optional. The badge appears after your session and target list have loaded, including for targets outside your stat range.
- **Quick suggestion:** on an unlisted player’s profile or attack page, tap **Suggest to NWA**, enter a reason and press **Send suggestion**. The player ID is selected automatically. You must be signed in; suggestions still need leader/co-leader approval. This does not change an unfinished draft in the main panel.
- **Suggestions:** suggest a player or faction with a required comment.
- **Approvals:** faction leaders and co-leaders can approve or reject suggestions.
- **History:** in Suggestions, view approved and rejected player/faction suggestions with the original reason, suggester and faction, submission time, reviewer and review time.

Your Limited key verifies your name and faction and reads your battle stats. We save it **encrypted in Supabase with an expiry of up to 7 days** so NWA can refresh hospital status and target faction rosters while you are offline. Status checks run every **30 seconds**, prioritizing usable targets and hospital releases within a limit per player. Faction rosters refresh every five minutes when a usable key is available. **Sign out and remove key** deletes all your saved keys and logins across devices. From userscript 0.9.2, older PC tabs cannot delete a newer saved login when their own session expires or is rejected. The script verifies the newer token through the backend before using it. Generic HTTP access errors preserve the login while blocking targets, and temporary restore failures show **Retry saved login** instead of asking for the key again. Normal seven-day expiry and confirmed revocation still require signing in again. The script saves a session token; a hash is stored by the backend so your login survives restarts until its original expiry. With backend 0.7.0 or later, phone and PC stay signed in together using the same or different Limited keys. Each login has its own expiry; signing in again does not extend your other logins.

Only allowed factions can use the list. Instant selection requires an availability check under 30 seconds old. A target can still enter hospital after a check. Battle stats are estimates; attacks are manual.

Disable any separate old **Torn Faction Target List** entry. Your installed version appears at the bottom of the target panel.
