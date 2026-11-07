# Kanata S VX9S Web Configurator

A browser-only configurator for the **Fantech Kanata S VX9S** mouse (USB `30FA:1040`). It talks to the
mouse directly over **WebHID**: nothing to install, no driver, no backend. Open the page, click
**Connect mouse**, and change lighting and DPI.

> Status: experimental. Unofficial and not affiliated with Fantech. Every action writes to the real
> mouse. Read [Safety](#safety) first.

## Features

- **Lighting**: static colour (one colour for the whole strip, 16 levels per channel, optional gamma
  correction), presets (ripple, twinkle, neon, rainbow, multi-colour, off), single-colour breathing
  with a live speed slider, per-LED selection, raw 8-byte hex sender.
- **Save lighting to mouse**: stores the chosen effect or colour as the power-up effect.
- **DPI**: edit all 6 stages (200 - 12800 DPI), choose the active stage, reload from the mouse.
- **Backups**: a backup of the touched memory is taken before each write, kept in the browser, and
  downloadable as a `.bin`.
- **Debug Mode**: shows every report sent (TX) and received (RX) as hex.

## Requirements

| Item | Needed |
|------|--------|
| Browser | Chromium-based with WebHID: Chrome, Edge, Brave, Opera. **Not** Firefox or Safari. |
| Page origin | A secure context: `https://...`, `http://localhost`, or `http://127.0.0.1`. `http://0.0.0.0` and LAN IPs do **not** work. |
| Linux | Usually nothing. A udev rule is needed only if the browser cannot open the device (see below). |
| Windows / macOS | Nothing extra. |
| Other software | Close the vendor app (and anything else talking to the mouse): only one program can use it at a time. |

## Run locally

The site is three static files, with no build step. Serve the folder with any static server, bound to
localhost:

```bash
cd web_dev
npx serve -l 8000
# any static file server works, as long as the page is opened as http://localhost:PORT
```

Open <http://localhost:8000>, click **Connect mouse**, and choose the Kanata device in the browser's
picker. The page remembers the permission and reconnects on the next visit.

## Linux permission (only if needed)

Many Linux setups already let the logged-in user open the mouse, so you may need to do nothing. Only
if the device picker lists the mouse but connecting fails with a permission error, add a udev rule.
To check first, run `ls -l /dev/hidraw*` with the mouse plugged in: if your user cannot read and
write the Kanata node, you need the rule.

```bash
sudo tee /etc/udev/rules.d/99-kanata.rules >/dev/null <<'EOF'
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="30fa", ATTRS{idProduct}=="1040", MODE="0666", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the mouse.

## Deploy

Upload the folder to any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages, your own server).
No server code runs; the page only needs to be served over HTTPS.

## Project layout

| File | Role |
|------|------|
| `index.html` | Page markup and styles. |
| `app.js` | UI logic: connection, tabs, lighting controls, DPI stages, backups list, request queue. |
| `kanata.js` | The driver: WebHID transport, config-memory access, DPI and lighting encoding, and the operations the UI calls. No dependencies. |

Layering inside `kanata.js`, bottom to top: `KanataDevice` (one feature report) -> `ConfigMemory`
(8-byte block read / write / patch / backup) -> `DpiConfig` and `Lighting` (encoding) -> `Ops`
(what the buttons call). `app.js` only uses `Kanata.Ops`, so the driver can be reused in another UI.

## How it talks to the mouse

The config channel is HID feature report **ID 7**, 8 bytes, in its own vendor collection (usage page
`0xFF01`, usage `1`), so browsers do not treat it as a protected mouse/keyboard collection.

| Report | Meaning |
|--------|---------|
| `07 18 03 <i> <lo> <hi> <val> <n-1>` | Stage byte `i` of an n-byte block at address `hi:lo` |
| `07 18 09 00 <lo> <hi> 00 <n-1>` | Commit the staged block |
| `07 18 05 <i> <lo> <hi> 00 <n-1>` | Select byte `i` for reading, then read the feature report |
| `07 18 00 ...` | Latch / idle, sent after each step |
| `07 18 10 00 ...` | Apply |
| `07 13 7f <effect> <led> 00 00 00` | Live lighting preset (not saved) |
| `07 14 <slot<<5 \| G> <R<<4 \| B> 00 ...` | Latch the live colour, then `07 13 ff a0 <n> ...` shows it as static |

Memory map used (configuration memory is `0x300` bytes):

| Address | Content |
|---------|---------|
| `0x13` | Bit `i` = bit 4 of the DPI code of stage `i` |
| `0x15 - 0x17` | Low nibbles of the 6 stage DPI codes, two per byte |
| `0x18` | `0x18` or active stage in the low 3 bits |
| `0x19` | Enabled-stage mask |
| `0x1c` | Stored (power-up) lighting effect |
| `0x20 + 3*stage` | Stage colour R, G, B: low nibble = channel, **inverted** (0 = full, 15 = off) |

Notes:

- Writes are read-modify-write per 8-byte block, verified by reading back, then applied.
- Applying DPI resets the mouse to its stored lighting, so the page re-sends the last lighting
  choice afterwards.
- Effect byte bit 7 = "use the colour latched by `07 14`". Single-colour breathing is `0x80 - 0x85`.
- Reading costs about 0.05 s per 8-byte block, so a full-memory read takes several seconds. Only
  small ranges are read per action.
- WebHID on Linux/Chromium returns the report ID as the first byte of a read; `getFeature()` handles
  both forms.

## Backups

Before a write that changes DPI or saved lighting, the page reads back the affected range and stores
it in the browser's `localStorage` (keys `kanata_backup_<UTC timestamp>`, newest 10 kept). On the
DPI tab, **Backups** lists them and **Download .bin** saves one as a raw memory dump.

Backups belong to one origin (host and port) and one browser profile, and clearing site data
deletes them. **Download the ones you want to keep.** There is no restore button yet.

## Safety

- All writes go to real hardware. Do not use **Raw hex** unless you know the packet.
- Back up before experimenting, and read before you write.
- If Debug Mode shows every RX line as `07 07 07 ...`, stop: reads are broken and any write would
  corrupt memory.
- Do not run two configurators at once.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| "navigator.hid is not available" | The page is not a secure context. Use `http://localhost:PORT` or HTTPS, not `0.0.0.0` or a LAN IP. The message prints the URL it sees. |
| The mouse is not in the picker | Another program holds it, or the wrong interface; close the vendor app, replug, retry. |
| "Failed to open the device" / permission error (Linux) | Add the udev rule above and replug. |
| `verify failed at 0x..` | A write did not read back correctly. Reload from mouse, check the Debug log, and compare against a downloaded backup before retrying. |
| Lighting resets after a DPI change | Expected: applying DPI reloads stored lighting. Use **Save lighting to mouse** to make it permanent. |
| Settings differ after unplugging | Live presets are not stored; only **Save lighting** and DPI apply are. |

## Browser support

Tested on Brave (Chromium) on Linux. Chrome and Edge should behave the same; Windows and macOS are
untested.

---

<p align="center">made with ❤️, by KacangNgoding</p>
