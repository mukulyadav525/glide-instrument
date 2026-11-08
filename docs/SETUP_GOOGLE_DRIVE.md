# Setting up Google Drive storage (once, about 15 minutes)

Done **once**, by the researcher, signed in to the Google account that should **own the study data**. Use the institute's account (IIIT-Delhi Google Workspace), not a personal Gmail, if the data-management plan says so.

## 1. Create the script

1. Go to <https://script.google.com> and click **New project**. Name it `GLIDE backend`.
2. Delete the sample code. Paste the whole of [`Code.gs`](../backend/apps_script/Code.gs).
3. Click the gear icon (**Project Settings**) and tick **Show "appsscript.json" manifest file in editor**. Open `appsscript.json` and replace its contents with [`appsscript.json`](../backend/apps_script/appsscript.json). Change `timeZone` if you are not in India.
4. Left sidebar: **Services** (+), add **Drive API** (v3). Without it, "delete video" sends files to the Drive trash (emptied after 30 days) instead of deleting them at once.
5. Click **Save**.

## 2. Run `setup()` once

1. In the function dropdown at the top, choose **setup** and click **Run**.
2. Google asks for permission (Drive, Sheets). Approve. If you see "Google hasn't verified this app", click **Advanced**, then **Go to GLIDE backend**. It is your own script.
3. Open **Execution log**. It prints:
   - the link to the new **`GLIDE_Study_Data`** folder in your Drive
   - **ADMIN_KEY**, which goes only into the admin console
   - **DEVICE_KEY**, which goes into each participant laptop through the setup link

   Keep both keys somewhere safe. If one leaks, run `rotateKeys()` and re-enter the new keys.

`setup()` creates:

```
GLIDE_Study_Data/
  _registry/GLIDE_Registry      one row per session: live status, uploads, withdrawal, video deletion
  _docs/README.txt              what every file is
  _analysis/                    for merged profiles and derived datasets later
  participants/                 <child code>/<child|educator>/<YYYY-MM-DD>_<session id>/  (created per session)
```

## 3. Deploy as a web app

1. **Deploy**, then **New deployment**, then the gear icon, then **Web app**.
2. **Execute as:** Me. **Who has access:** Anyone.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`).

"Anyone" only lets a request reach the script. Every request without one of the two keys is refused. The device key can only join sessions, send status and upload into session folders. It cannot list, read, download or delete study data.

When you change `Code.gs` later: **Deploy**, then **Manage deployments**, then edit (pencil), then **Version: New version**. The URL stays the same.

> **Updating from v5.0 to v5.1:** paste the new `Code.gs` over the old one, **Save**, then deploy a **new version** as above. Do **not** run `setup()` again: the keys and folders stay as they are. v5.1 adds two operations, `edu_join` and `signal`, used by the educator portal. Until the script is updated, the portal shows *unknown_op* and the laptop works with its own panel. Check with the admin console: its header should say `glide-backend-5.1.0`.

## 4. Connect the admin console

Open `admin.html`. You can use the copy on the hosted instrument site, or open it straight from disk. It works on a phone or tablet too.

1. Paste the `/exec` URL and the **ADMIN_KEY**. Click **Save and test**. The header should say *connected*.
2. Open **Set up a participant laptop**. Enter where the instrument is hosted (its `index.html` address) and the **DEVICE_KEY**. Click **Make the setup link**. The same two settings make the **educator portal link** that appears with every new session.
3. Open that link **once on each participant laptop**. It stores the backend address and device key in that laptop's browser and removes them from the address bar.

## 5. Check it end to end before the first real session

- In the admin console, create a test session with child code `TEST-01` and video plus eye tracking ticked.
- On the participant laptop, enter the join code and run through to the end. (A real child code is never used for this.)
- Check that `GLIDE_Study_Data/participants/TEST-01/child/<date>_<id>/` holds `manifest.json` and the CSVs, and that `video/part_001.webm` plays.
- Delete the test folder and its registry row.

## Limits worth knowing

| | |
|---|---|
| Largest single upload | ~30 MB per file (video parts are ~7 MB: 2 minutes at 500 kbit/s) |
| Apps Script quotas | Consumer accounts: ~90 min of script runtime per day. A 45-minute session with video is about 25 uploads plus ~540 heartbeats, well within it. Workspace accounts have higher limits. |
| Heartbeat | Every 5 s per running session; the registry sheet is updated at most every 30 s. |
| Educator portal | Each laptop checks for a portal every 3 s for the first two minutes, then every 8 s (every 15 s once connected). Connecting takes about four small requests. The video never goes through the script. |
| Offline | Nothing is lost when the network drops. Files wait in the laptop's queue and upload when the instrument page is next open with a connection. |
