# A+Piano — MIDI Input Test (slice 1)

A single-page check that your keyboard is seen by the phone, that notes light on screen, and that velocity and octave shifts are reported clearly. There is no sound, and nothing is saved.

This folder is meant to become the public site later. It contains only the app and this note — no player data, and no pieces that are not public domain.

## How to test on the phone

Web MIDI needs a **secure context**: `https` or `localhost`. A plain `http://192.168.…` address will not work. Chrome (or another Chromium browser) on Android is required. Safari and every browser on iPhone and iPad cannot use Web MIDI.

Once this is on GitHub Pages, open:

`https://abacusplusorg.github.io/Piano/`

Until then, you can try it on a laptop in Chrome at `http://localhost:<port>/` after serving this folder, or on the phone once there is an `https` link.

1. Plug the Miditech Garagekey Mini into the phone (USB-B to USB-C). It is class-compliant and bus-powered; no extra driver.
2. Open the page in Chrome and tap the **Tap to connect MIDI keyboard** button. Allow access if the browser asks.
3. Play some keys. They should light while held, brighter at higher velocity.
4. Press the octave − / + buttons and play again. Watch **Lowest seen** and **Highest seen**.
5. Optionally open the log if something looks off.

On-screen keys can be tapped to test without a MIDI keyboard. Those events are marked `touch` in the log.

## What to report back

- The **device name** shown after connecting.
- Whether notes **light correctly** while held, and go dark on release (try a short note and a held chord).
- **Lowest seen** and **Highest seen** with the octave buttons at the default setting (expected range is C3–C6 on a Garagekey Mini (MIDI 48–84); the on-screen keyboard starts at C4–C5 and switches to the connected keyboard's range in the C4 = 60 convention — report the numbers the app shows, even if they differ).
- What those two values do after you press octave − and octave + once each.
- The **velocity** range you see from a soft press and a hard press.
- Whether anything felt **laggy**, and the on-screen delay figure (that number is visual lag only; the app does not play sound).
- A **screenshot of the log** if a message looks wrong, a key sticks, or a device never appears.

Also mention the browser and OS if anything fails (for example “Chrome on GrapheneOS, permission prompt never appeared”).

## Files

- `index.html` — page structure
- `css/style.css` — styles
- `js/app.js` — MIDI input, on-screen keyboard, log
- `data/keyboards.json` — known MIDI keyboards: key count, key size (full-size, slim or mini), default range where a manual confirms it, and a pattern for the name each reports over USB, with sources. A matched keyboard sizes the on-screen keys right away; with only a key count the range is marked estimated and slides into place as notes are played.
- `data/key-proportions.json` — measured or typical key dimensions (mm) and sources, used to draw white and black keys in the right proportions for the connected keyboard.
- `tests/verify.mjs` — headless Chrome checks (needs puppeteer-core and a local server on port 8766)
