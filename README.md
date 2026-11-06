# Hostel Desk (phone-only version)

The same app, but with no server. All the logic runs inside the page and your data is stored in
your phone's browser, so it works without your laptop and even without internet.

Trade-off: the data lives only on the device you use it on. Use Settings, Download backup
now and then, and keep that file somewhere safe (Drive, WhatsApp to yourself).

## Put it online for free (GitHub Pages, about 5 minutes, no git needed)

1. Make a free account at github.com and click New repository. Name it `hostel-desk`, choose Public, create it.
2. On the new repo page click "uploading an existing file". Drag in everything from this folder:
   `index.html`, `engine.js`, `sw.js`, `manifest.webmanifest` and the four `.png` files. Click Commit changes.
3. Go to Settings, then Pages. Under "Build and deployment" choose Deploy from a branch, branch `main`, folder `/ (root)`, Save.
4. After a minute or two the page shows your address: `https://YOUR-USERNAME.github.io/hostel-desk/`

The repo is public, but only the app's code is there. Your data never leaves your phone,
so never upload a backup file to the repo.

## Install it on your phone

- **Android (Chrome):** open the address, tap the three dots, then "Add to Home screen" or "Install app".
- **iPhone (Safari):** open the address, tap Share, then "Add to Home Screen". Do the install
  before restoring data, because the home-screen app keeps its own storage separate from Safari.

## Move your laptop data to the phone

1. On the laptop version: Settings, Download my data. This saves a `.json` file.
2. Send that file to your phone.
3. In the phone app: Settings, Restore from backup, pick the file. It replaces what is on the phone.

## Try it on your laptop first

```
cd hostel-offline
python -m http.server 8000
```

Open http://127.0.0.1:8000. (Opening index.html by double-click won't work, because offline mode
needs a web address.)

## Auto-log UPI payments (Android)

Google Pay doesn't share your payments with other apps, but your bank texts you for each one. A free
automation app can react to that text and open Hostel Desk with the amount already filled in.

1. Install **MacroDroid** from the Play Store and allow the permissions it asks for (SMS, notifications).
2. Add a macro. **Trigger:** SMS Received, with the message containing `debited`.
3. **Action:** Open Website / URL, using this address (put your own address first, and the magic text
   `[sms_message]` at the end):

   `https://YOUR-USERNAME.github.io/hostel-desk/?sms=[sms_message]`

4. Save the macro and pay something small to test. Hostel Desk opens with `spent 75 on` in the log bar and a
   line saying how much was paid and to which UPI id. Type the reason and tap Log.

Notes: it only works for payments your bank sends an SMS for. Messages about money coming in are ignored.
If an SMS contains a `#` or `&` the link may be cut off. The amount is almost always first in the text, so it
still works. Otherwise type the amount yourself. You can also use `?amount=120` instead of `?sms=...`.

A **Log a payment** shortcut also appears when you long-press the home-screen icon on Android.

## Updating the app later

Replace the files in the repo. In `sw.js` change `VERSION` (for example `hostel-desk-v3`) so phones
fetch the new files. They show up the second time you open the app.

## Files

| File | What it does |
|---|---|
| `index.html` | The interface. |
| `engine.js` | All the logic and storage, ported from `core.py`. |
| `sw.js` | Keeps the app files on the phone for offline use. Your data is not in this cache. |
| `manifest.webmanifest` and `*.png` | Name and icons for "Add to Home screen". |
