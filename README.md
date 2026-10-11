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

## Start

Open Torn and click the green **NWA** button on the right edge. Sign in with your **Limited Torn API key** the first time.

NWA prepares targets in the background. Click **NWA** to open a target within your stat range that was recently confirmed available. You start the attack yourself. On first load, or when checks are old, NWA checks availability before opening a target and tries up to five matches.

The small **⚙** underneath opens settings, the target list, and suggestions. Set **Min** and **Max** target stats as percentages of your own total; NWA only picks targets within that range. The default is **10–60%**, with the equivalent stat totals shown underneath. Your settings are saved between pages, and your existing maximum is kept when updating. Set **Min** to **0%** to include weaker targets.

<img src="docs/images/nwa-controls.png" width="720" alt="Actual NWA controls with arrows: NWA finds a target and the gear underneath opens settings">

<img src="docs/images/nwa-login.png" width="720" alt="Actual NWA sign-in panel: read the key storage notice, enter your Limited Torn API key and tap Sign in and save key">

The backend is already set to [targetlist.grusmedia.no](https://targetlist.grusmedia.no). You only need your Torn key.

## Use

- **Targets:** browse the list or filter by estimated stats. **Possible matches** applies both your minimum and maximum.
- **Check status:** check a target before opening its attack page.
- **Profiles and attack pages:** listed players show an NWA notice with their saved reason. This appears after your session and target list have loaded, including for targets outside your stat range.
- **Suggestions:** suggest a player or faction with a required comment.
- **Approvals:** faction leaders and co-leaders can approve or reject suggestions.

Your Limited key verifies your name and faction and reads your battle stats. We save it **encrypted in Supabase with an expiry of up to 7 days** so NWA can refresh target hospital and availability status in the background, including while you are offline. Checks run every **30 seconds**, within a limit per player. **Sign out and remove key** deletes your saved key. The script saves a session token; a backend restart requires signing in again, while saved keys can still support background checks until they expire.

Only allowed factions can use the list. Instant selection requires an availability check under 30 seconds old. A target can still enter hospital after a check. Battle stats are estimates; attacks are manual.

Disable any separate old **Torn Faction Target List** entry. Your installed version appears in the settings header.
