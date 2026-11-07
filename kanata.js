// Driver for the Fantech Kanata S VX9S over WebHID. Classic script (no modules, no build step).
//
// Layers, bottom to top: KanataDevice (one 8-byte feature report) -> ConfigMemory (block
// read/write/patch/backup) -> DpiConfig / Lighting (encoding) -> Ops (what the UI calls).
//
// WebHID: report ID 7 is passed separately when sending, so sendFeatureReport(7, ...) takes the 7
// bytes AFTER the ID; a read may return the ID as its first byte (see getFeature).
"use strict";

const Kanata = (() => {
  const VID = 0x30FA, PID = 0x1040;
  const USAGE_PAGE = 0xFF01, USAGE = 0x01;   // vendor collection that holds report ID 7 (interface 1)
  const IMAGE_SIZE = 0x300, BLOCK = 8, MAX_BACKUPS = 10;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- effect table (kanata_led.MODES); "static" is 0x20 and not listed ----
  const MODES = {
    "breath-slow": 0x80, "breath-1": 0x81, "breath-medium": 0x82,
    "breath-3": 0x83, "breath-fast": 0x84, "breath-veryfast": 0x85,
    "multi color": 0x10, "multi-slow": 0x11, "multi-medium": 0x12,
    "multi-3": 0x13, "multi-fast": 0x14,
    "ripple": 0x30, "twinkle": 0x40, "neon-rgb": 0x60,
    "rainbow": 0x70, "off": 0xFF,
  };
  const GROUPS = {
    "Single-colour breathing": Object.keys(MODES).filter((m) => m.startsWith("breath")),
    "Breathing Multi-colour": Object.keys(MODES).filter((m) => m.startsWith("multi")),
    "Other": Object.keys(MODES).filter((m) => !m.startsWith("breath") && !m.startsWith("multi")),
  };
  const STATIC_EFFECT = 0x20, LED_ALL = 5;
  const LIGHT_RESEND_DELAY = 200;   // ms to wait after apply before re-sending the preset

  // ---- DPI (kanata_dpi) ----
  const DPI_CODES = {1: 200, 2: 400, 3: 600, 4: 800, 5: 1000, 6: 1200, 7: 1400, 8: 1600,
    9: 1800, 10: 2000, 12: 2400, 13: 3200, 14: 4000, 15: 4800, 16: 5600, 17: 6400,
    18: 7200, 19: 8000, 20: 8800, 21: 9600, 22: 10400, 23: 11200, 24: 12800};
  const DPI_VALUES = Object.values(DPI_CODES);
  const STAGES = 6;
  const ADDR_HIGH_BITS = 0x13, ADDR_NIBBLES = 0x15, ADDR_ACTIVE = 0x18, ADDR_ENABLED = 0x19;
  const ADDR_MODE_BYTE = 0x1C, ADDR_STAGE_COLOURS = 0x20;
  const BACKUP_BYTES = 0x20, COLOUR_BACKUP_BYTES = 0x38;

  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join(" ");

  // ---------------------------------------------------------------------------------------------
  class KanataDevice {
    constructor(hid) { this.hid = hid; this.trace = null; }

    static supported() { return "hid" in navigator; }

    /** Must be called from a click handler. Shows Chrome's device picker. */
    static async request() {
      const [hid] = await navigator.hid.requestDevice({
        filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE, usage: USAGE }],
      });
      return hid ? KanataDevice.open(hid) : null;
    }

    /** Re-open a device the user already granted (no click needed). */
    static async reconnect() {
      const hid = (await navigator.hid.getDevices()).find((d) => d.vendorId === VID && d.productId === PID
        && d.collections.some((c) => c.usagePage === USAGE_PAGE));
      return hid ? KanataDevice.open(hid) : null;
    }

    static async open(hid) {
      if (!hid.opened) await hid.open();
      return new KanataDevice(hid);
    }

    async close() { await this.hid.close(); }

    /** data = the 8 bytes `07 xx ...` (report ID first). */
    async setFeature(data) {
      data = Uint8Array.from(data);
      if (data.length !== 8 || data[0] !== 7) throw new Error("feature report must be 8 bytes starting with 07, got " + hex(data));
      if (this.trace) this.trace("TX", data);
      await this.hid.sendFeatureReport(7, data.slice(1));
    }

    // Verified on the real mouse (Brave/Linux): the DataView INCLUDES the report ID as its first
    // byte (8 bytes, 07 xx ...), so every byte read came back as 07 when it was assumed to be
    // missing. Accept both forms so other platforms that strip it still work.
    async getFeature() {
      const v = await this.hid.receiveFeatureReport(7);
      const raw = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      const buf = new Uint8Array(8);
      if (raw.length >= 8 && raw[0] === 7) buf.set(raw.subarray(0, 8));
      else { buf[0] = 7; buf.set(raw.subarray(0, 7), 1); }
      if (this.trace) this.trace("RX", buf);
      return buf;
    }
  }

  // ---------------------------------------------------------------------------------------------
  class ConfigMemory {
    constructor(dev) { this.dev = dev; }

    _cmd(sub, idx, addr, val, n) { return this.dev.setFeature([7, 0x18, sub, idx, addr & 0xFF, addr >> 8, val, n]); }

    async readBlock(addr, n = BLOCK) {
      for (let i = 0; i < n; i++) { await this._cmd(0x03, i, addr, 0, n - 1); await sleep(2); }
      await sleep(2);
      await this._cmd(0x00, 0, addr, 0, 0);
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        await this._cmd(0x05, i, addr, 0, n - 1);
        await sleep(2);
        out[i] = (await this.dev.getFeature())[1];
      }
      await sleep(2);
      await this._cmd(0x00, 0, 0, 0, 0);
      return out;
    }

    async writeBlock(addr, data) {
      const n = data.length;
      if (n < 1 || n > BLOCK) throw new Error("block must be 1..8 bytes");
      for (let i = 0; i < n; i++) await this._cmd(0x03, i, addr, data[i], n - 1);
      await sleep(4);
      await this._cmd(0x09, 0, addr, 0, n - 1);
      await sleep(2);
      await this._cmd(0x00, 0, addr, 0, 0);
    }

    async apply() {
      await this._cmd(0x10, 0, 0, 0, 0);
      await sleep(5);
      await this._cmd(0x00, 0, 0, 0, 0);
    }

    async readImage(size = IMAGE_SIZE) {
      const out = new Uint8Array(size);
      for (let a = 0; a < size; a += BLOCK) out.set(await this.readBlock(a), a);
      return out;
    }

    /** changes = {address: byte}. Read-modify-write each touched 8-byte block, verify, apply. */
    async patch(changes) {
      const addrs = Object.keys(changes).map(Number);
      for (const base of [...new Set(addrs.map((a) => a & ~7))].sort((a, b) => a - b)) {
        const cur = await this.readBlock(base);
        for (const a of addrs) if ((a & ~7) === base) cur[a - base] = changes[a];
        await this.writeBlock(base, cur);
        const got = await this.readBlock(base);
        if (hex(got) !== hex(cur))
          throw new Error(`verify failed at 0x${base.toString(16)}: wrote ${hex(cur)} read ${hex(got)}`);
      }
      await this.apply();
    }

    /** Keeps the newest MAX_BACKUPS in localStorage; returns the key. Download with downloadBackup(). */
    async backup(size = IMAGE_SIZE) {
      const img = await this.readImage(size);
      const key = "kanata_backup_" + new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      localStorage.setItem(key, hex(img));
      const keys = Object.keys(localStorage).filter((k) => /^kanata_backup_\d+$/.test(k)).sort();
      for (const old of keys.slice(0, -MAX_BACKUPS)) localStorage.removeItem(old);
      return key;
    }
  }

  function listBackups() {
    return Object.keys(localStorage).filter((k) => /^kanata_backup_\d+$/.test(k)).sort();
  }
  function downloadBackup(key) {
    const bytes = Uint8Array.from(localStorage.getItem(key).split(" "), (h) => parseInt(h, 16));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    a.download = key + ".bin";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------------------------------------------------------------------------------------------
  class DpiConfig {
    constructor(codes, active, enabledMask, activeByte = 0x18) {
      this.codes = codes; this.active = active; this.enabledMask = enabledMask; this.activeByte = activeByte;
    }
    static fromImage(img) {
      const nib = [];
      for (const b of img.slice(ADDR_NIBBLES, ADDR_NIBBLES + 3)) nib.push(b >> 4, b & 15);
      const codes = nib.map((n, i) => n | (((img[ADDR_HIGH_BITS] >> i) & 1) << 4));
      return new DpiConfig(codes, img[ADDR_ACTIVE] & 7, img[ADDR_ENABLED] & 0x3F, img[ADDR_ACTIVE]);
    }
    static async load(mem) { return DpiConfig.fromImage(await mem.readImage(0x20)); }
    dpi(stage) { return DPI_CODES[this.codes[stage]] ?? "?"; }
    setStage(stage, dpi) {
      if (!(stage >= 0 && stage < STAGES)) throw new Error("stage must be 0-5");
      const code = Object.keys(DPI_CODES).find((k) => DPI_CODES[k] === dpi);
      if (code === undefined) throw new Error("DPI must be one of " + DPI_VALUES.join(", "));
      this.codes[stage] = Number(code);
    }
    setActive(stage) {
      if (!(stage >= 0 && stage < STAGES)) throw new Error("active stage must be 0-5");
      this.active = stage;
    }
    toChanges() {
      const hi = this.codes.reduce((s, c, i) => s | (((c >> 4) & 1) << i), 0);
      const n = this.codes.map((c) => c & 15);
      return {
        [ADDR_HIGH_BITS]: hi,
        [ADDR_NIBBLES]: n[0] << 4 | n[1],
        [ADDR_NIBBLES + 1]: n[2] << 4 | n[3],
        [ADDR_NIBBLES + 2]: n[4] << 4 | n[5],
        [ADDR_ACTIVE]: (this.activeByte & ~7) | this.active,
      };
    }
  }

  // ---------------------------------------------------------------------------------------------
  const Lighting = {
    /** Colour channel 0-255 -> inverted 4-bit (0 = full, 15 = off). */
    inv(v, gamma = 1) {
      if (!(v >= 0 && v <= 255)) throw new Error("color channels are 0-255");
      if (gamma !== 1) v = Math.round(255 * (v / 255) ** gamma);
      return 15 - Math.round(v / 17);
    },
    async setPreset(dev, effect, led = LED_ALL) {
      if (!(led >= 0 && led <= LED_ALL)) throw new Error("led must be 0-5 (5 = all)");
      await dev.setFeature([7, 0x13, 0x7F, effect, led, 0, 0, 0]);
    },
    async setStaticRgb(dev, r, g, b, leds = 4, gamma = 1, slot = 3) {
      if (!(leds >= 0 && leds <= 4)) throw new Error("leds must be 0-4 (lights LEDs 0..n)");
      if (!(gamma >= 0.5 && gamma <= 4)) throw new Error("gamma must be 0.5-4");
      if (!(slot >= 0 && slot <= 5)) throw new Error("slot must be 0-5");
      const inv = (v) => Lighting.inv(v, gamma);
      await dev.setFeature([7, 0x14, slot << 5 | inv(g), inv(r) << 4 | inv(b), 0, 0, 0, 0]);
      await sleep(30);
      await dev.setFeature([7, 0x13, 0xFF, 0xA0, leds, 0, 0, 0]);
    },
    stageColourChanges(stage, current, r, g, b, gamma = 1) {
      if (!(stage >= 0 && stage <= 5)) throw new Error("stage must be 0-5");
      const base = ADDR_STAGE_COLOURS + 3 * stage, out = {};
      [r, g, b].forEach((v, k) => { out[base + k] = (current[k] & 0xF0) | Lighting.inv(v, gamma); });
      return out;
    },
    /** Live effect byte -> image byte 0x1c, or null when it has no stored form (0x80+). */
    storedModeByte(effect, current = 0xE3) {
      if (effect >= 0x80) return null;
      return 0x80 | (effect & 0x70) | ((effect & 0x0F) || (current & 0x0F));
    },
  };

  const checkRgb = (rgb, what = "rgb") => {
    rgb = rgb.map(Number);
    if (rgb.length !== 3 || !rgb.every((c) => c >= 0 && c <= 255)) throw new Error(what + " must be three values 0-255");
    return rgb;
  };

  // ---------------------------------------------------------------------------------------------
  // Operations (what the UI buttons call). `dev` = KanataDevice. Only one may run at a time;
  // app.js serialises them.
  const Ops = {
    async readDpi(dev) {
      const cfg = await DpiConfig.load(new ConfigMemory(dev));
      return { stages: cfg.codes.map((c, i) => (c in DPI_CODES ? cfg.dpi(i) : null)), active: cfg.active };
    },

    async writeDpi(dev, stages, active, light = null) {
      if (stages.length !== STAGES) throw new Error("need " + STAGES + " stage values");
      let rgb = null, colour = null, effect, led, cleds, cgamma, crgb;
      if (light && light.rgb) {
        rgb = checkRgb(light.rgb);
        effect = STATIC_EFFECT; led = Number(light.leds ?? 4);
      } else if (light) {
        effect = MODES[light.mode];
        if (effect === undefined) throw new Error("unknown mode " + light.mode);
        led = Number(light.led ?? LED_ALL);
        colour = effect >= 0x80 && effect <= 0x8F ? light.colour : null;
        if (colour) {
          crgb = checkRgb(colour.rgb, "colour.rgb");
          cleds = Number(colour.leds ?? 4); cgamma = Number(colour.gamma ?? 1);
        }
      }
      const mem = new ConfigMemory(dev);
      const cfg = await DpiConfig.load(mem);
      stages.forEach((v, i) => { if (v !== null) cfg.setStage(i, Number(v)); });
      cfg.setActive(Number(active));
      const backup = await mem.backup(BACKUP_BYTES);
      const stored = light ? Lighting.storedModeByte(effect, (await mem.readBlock(0x18))[4]) : null;
      const changes = cfg.toChanges();
      if (stored !== null) changes[ADDR_MODE_BYTE] = stored;   // fallback effect == the one the user picked
      await mem.patch(changes);
      const done = await DpiConfig.load(mem);
      if (light) {
        await sleep(LIGHT_RESEND_DELAY);   // the mouse reloads stored lighting shortly after apply
        if (rgb) {
          await Lighting.setStaticRgb(dev, ...rgb, led, Number(light.gamma ?? 1), Number(active));
        } else {
          if (colour) {
            await Lighting.setStaticRgb(dev, ...crgb, cleds, cgamma, Number(active));
            await sleep(LIGHT_RESEND_DELAY);
          }
          await Lighting.setPreset(dev, effect, led);
        }
      }
      return { stages: done.codes.map((_, i) => done.dpi(i)), active: done.active, backup };
    },

    async sendColor(dev, req) {
      const rgb = checkRgb(req.rgb), leds = Number(req.leds ?? 4), gamma = Number(req.gamma ?? 1);
      // the mouse shows the colour of the ACTIVE DPI stage, so send to that slot
      let slot = (await new ConfigMemory(dev).readBlock(0x18))[0] & 7;
      if (slot > 5) slot = 3;
      await Lighting.setStaticRgb(dev, ...rgb, leds, gamma, slot);
      return `rgb=${rgb} leds=0..${leds} gamma=${gamma} slot=${slot}`;
    },

    async sendLight(dev, req) {
      if (req.raw !== undefined) {
        const bytes = req.raw.trim().split(/\s+/).map((h) => parseInt(h, 16));
        if (bytes.length !== 8 || bytes[0] !== 7 || bytes.some(Number.isNaN))
          throw new Error("raw must be exactly 8 bytes starting with 07");
        await dev.setFeature(bytes);
        return hex(bytes);
      }
      const effect = MODES[req.mode];
      if (effect === undefined) throw new Error("unknown mode " + req.mode);
      const led = Number(req.led ?? LED_ALL);
      await Lighting.setPreset(dev, effect, led);
      return hex([7, 0x13, 0x7F, effect, led, 0, 0, 0]);
    },

    async saveLight(dev, light) {
      let rgb = null, effect, led;
      if (light.rgb) {
        rgb = checkRgb(light.rgb); effect = STATIC_EFFECT; led = Number(light.leds ?? 4);
      } else {
        effect = MODES[light.mode];
        if (effect === undefined) throw new Error("unknown mode " + light.mode);
        led = Number(light.led ?? LED_ALL);
      }
      const mem = new ConfigMemory(dev);
      const head = await mem.readBlock(0x18);
      const stored = Lighting.storedModeByte(effect, head[4]);
      if (stored === null)
        throw new Error("this effect cannot be saved in the mouse (breathing speeds and off have no stored form); pick another effect or a static colour");
      let slot = head[0] & 7;
      if (slot > 5) slot = 3;
      const gamma = Number(light.gamma ?? 1);
      const changes = { [ADDR_MODE_BYTE]: stored };
      if (rgb) Object.assign(changes, Lighting.stageColourChanges(slot, await mem.readBlock(ADDR_STAGE_COLOURS + 3 * slot, 3), ...rgb, gamma));
      const backup = await mem.backup(COLOUR_BACKUP_BYTES);
      await mem.patch(changes);
      await sleep(LIGHT_RESEND_DELAY);
      if (rgb) await Lighting.setStaticRgb(dev, ...rgb, led, gamma, slot);
      else await Lighting.setPreset(dev, effect, led);
      return { stored: "0x1c=0x" + stored.toString(16).padStart(2, "0"), backup };
    },
  };

  return { KanataDevice, ConfigMemory, DpiConfig, Lighting, Ops, MODES, GROUPS, DPI_VALUES, STAGES,
           listBackups, downloadBackup, hex };
})();
