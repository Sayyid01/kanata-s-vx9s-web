// UI logic. api() runs one operation at a time directly against the mouse through kanata.js
// (WebHID); there is no server.

// http://0.0.0.0:PORT is not a secure context, so WebHID is missing there; localhost is.
if (location.hostname === "0.0.0.0") location.replace(location.href.replace("//0.0.0.0", "//localhost"));
const st = document.getElementById("status");
const busy = (msg) => { st.className = ""; st.textContent = msg; };
const fail = (e) => { st.className = "err"; st.textContent = "Error: " + e.message; console.error(e); };

const { GROUPS, DPI_VALUES, STAGES } = Kanata;

function showTab(name) {
  for (const t of ["lighting", "dpi"]) {
    document.getElementById("tab-" + t).className = "tab" + (t === name ? " sel" : "");
    document.getElementById("tabbtn-" + t).className = t === name ? "sel" : "";
  }
}

const dbg = document.getElementById("debug");
const dbgLog = document.getElementById("debuglog");
const dbgClear = document.getElementById("debugclear");
dbg.onchange = () => { dbgLog.style.display = dbgClear.style.display = dbg.checked ? "block" : "none"; };
const clearLog = () => { dbgLog.value = ""; };
function addLog(title, lines) {
  if (!lines || !lines.length) return;
  dbgLog.value += "# " + title + "\n" + lines.join("\n") + "\n";
  dbgLog.scrollTop = dbgLog.scrollHeight;
}

// ---- connection ----
let device = null;
const connBtn = document.getElementById("connect");
const connInfo = document.getElementById("conninfo");
function setConnected(d) {
  device = d;
  connBtn.textContent = d ? "Disconnect" : "Connect mouse";
  connInfo.textContent = d ? "connected: " + d.hid.productName : "not connected";
}
async function toggleConnect() {
  try {
    if (device) { await device.close(); setConnected(null); return; }
    const d = await Kanata.KanataDevice.request();
    if (!d) return;
    setConnected(d);
    loadDpi();
  } catch (e) { fail(e); }
}
if (!Kanata.KanataDevice.supported()) {
  const box = document.getElementById("nohid");
  box.style.display = "block";
  box.textContent = "navigator.hid is not available. location=" + location.href +
    "  secureContext=" + window.isSecureContext + "  brave=" + !!navigator.brave +
    ". WebHID needs a secure context: open http://localhost:PORT or http://127.0.0.1:PORT " +
    "(not a LAN IP or hostname) or an https:// page.";
  connBtn.disabled = true;
} else {
  navigator.hid.addEventListener("disconnect", (ev) => { if (device && ev.device === device.hid) setConnected(null); });
  Kanata.KanataDevice.reconnect().then((d) => { if (d) { setConnected(d); loadDpi(); } else setConnected(null); })
    .catch(fail);
}

// The mouse needs serial access: run one operation at a time.
let chain = Promise.resolve();
function api(title, fn) {
  const run = async () => {
    if (!device) throw new Error("connect the mouse first");
    const log = [];
    const t0 = performance.now();
    device.trace = dbg.checked
      ? (dir, data) => log.push("+" + (performance.now() - t0).toFixed(1).padStart(8) + "ms  " + dir + "  " + Kanata.hex(data))
      : null;
    try { return await fn(device); }
    finally { device.trace = null; if (dbg.checked) addLog(title, log); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// ---- lighting ----
const led = document.getElementById("led");
led.add(new Option("all", "5"));
for (let i = 0; i < 5; i++) led.add(new Option(String(i), String(i)));
const root = document.getElementById("groups");
for (const [title, names] of Object.entries(GROUPS)) {
  const h = document.createElement("h2"); h.textContent = title; root.appendChild(h);
  if (title.includes("reathing")) { addBreathing(names, title.startsWith("Single") ? "Breathing" : "Multi-colour"); continue; }
  const g = document.createElement("div"); g.className = "grid"; root.appendChild(g);
  for (const n of names) {
    const b = document.createElement("button"); b.textContent = n;
    if (n === "off") b.className = "off";
    b.onclick = () => light({ mode: n, led: Number(led.value) }, n); g.appendChild(b);
  }
}
// One button + speed slider per breathing group; every slider move is applied at once. Operations
// are serialised, so send one, then only the newest value that arrived meanwhile.
function addBreathing(names, label) {
  const row = document.createElement("div"); row.className = "row"; root.appendChild(row);
  const btn = document.createElement("button"); btn.textContent = label;
  const slider = document.createElement("input"); slider.type = "range"; slider.min = 0;
  slider.max = names.length - 1; slider.step = 1; slider.value = Math.min(2, names.length - 1);
  slider.style.cssText = "width:14rem;padding:0";
  const name = document.createElement("small");
  const show = () => { name.textContent = "speed " + (Number(slider.value) + 1) + " / " + names.length; };
  let sending = false, pending = null;
  async function flush() {
    if (sending) return;
    sending = true;
    try {
      while (pending !== null) {
        const n = names[pending]; pending = null;
        await light({ mode: n, led: Number(led.value) }, n);
      }
    } finally { sending = false; }
  }
  const apply = () => { show(); pending = Number(slider.value); flush(); };
  btn.onclick = apply; slider.oninput = apply; show();
  const slow = document.createElement("small"); slow.textContent = "slow";
  const fast = document.createElement("small"); fast.textContent = "fast";
  row.append(btn, slow, slider, fast, name);
}
let lastLight = null;   // last preset picked; re-sent after a DPI apply (apply resets lighting)
let lastColour = null;  // last "Set colour"; breathing presets use it, so it is re-latched with them
async function light(body, label) {
  busy("Sending " + label + "...");
  try {
    const payload = await api("light " + label, (d) => Kanata.Ops.sendLight(d, body));
    if (body.mode) lastLight = lastColour ? Object.assign({ colour: lastColour }, body) : body;
    st.textContent = "OK: " + label + "  [" + payload + "]";
  } catch (e) { fail(e); }
}
const sendRaw = () => light({ raw: document.getElementById("raw").value }, "raw");
async function saveLight() {
  if (!lastLight) { fail(new Error("pick a preset or set a colour first")); return; }
  busy("Saving lighting in the mouse (backup, write, verify)...");
  try {
    const j = await api("save lighting", (d) => Kanata.Ops.saveLight(d, lastLight));
    st.textContent = "OK: saved as the power-up effect (" + j.stored + "). Backup: " + j.backup;
  } catch (e) { fail(e); }
}
const leds = document.getElementById("leds");
[["all (0-4)", 4], ["0-3", 3], ["0-2", 2], ["0-1", 1], ["0 only", 0]].forEach(([t, v]) => leds.add(new Option(t, String(v))));
async function sendColor() {
  const h = document.getElementById("rgb").value;
  const rgb = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  busy("Sending colour " + h + "...");
  try {
    const gm = document.getElementById("gamma").checked ? 2.2 : 1.0;
    const payload = await api("colour " + h, (d) => Kanata.Ops.sendColor(d, { rgb: rgb, leds: Number(leds.value), gamma: gm }));
    lastColour = { rgb: rgb, leds: Number(leds.value), gamma: gm };
    lastLight = lastColour;
    st.textContent = "OK: colour " + h + "  [" + payload + "]";
  } catch (e) { fail(e); }
}

// ---- DPI ----
const stagesDiv = document.getElementById("stages");
const selects = [];
let activeStage = 0;
for (let i = 0; i < STAGES; i++) {
  const row = document.createElement("div"); row.className = "stage"; row.id = "stage" + i;
  const lbl = document.createElement("span"); lbl.textContent = "Stage " + i;
  const sel = document.createElement("select");
  for (const v of DPI_VALUES) sel.add(new Option(v + " DPI", String(v)));
  const act = document.createElement("button"); act.textContent = "Set active";
  act.onclick = () => { activeStage = i; markActive(); };
  row.append(lbl, sel, act); stagesDiv.appendChild(row); selects.push(sel);
}
function markActive() {
  for (let i = 0; i < STAGES; i++)
    document.getElementById("stage" + i).className = "stage" + (i === activeStage ? " active" : "");
}
async function loadDpi() {
  busy("Reading DPI from the mouse (a few seconds)...");
  try {
    const j = await api("read DPI", (d) => Kanata.Ops.readDpi(d));
    j.stages.forEach((v, i) => { if (v !== null) selects[i].value = String(v); });
    activeStage = j.active; markActive();
    st.textContent = "OK: loaded, active stage " + j.active + " (" + j.stages[j.active] + " DPI)";
  } catch (e) { fail(e); }
}
async function applyDpi() {
  busy("Writing DPI (backup, write, verify; takes a few seconds)...");
  try {
    const j = await api("write DPI", (d) => Kanata.Ops.writeDpi(d, selects.map(s => Number(s.value)), activeStage, lastLight));
    st.textContent = "OK: applied, active stage " + j.active + " (" + j.stages[j.active] + " DPI). Backup: " + j.backup;
    refreshBackups();
  } catch (e) { fail(e); }
}

// ---- backups (browser storage; download to keep) ----
const backupSel = document.getElementById("backups");
function refreshBackups() {
  backupSel.length = 0;
  for (const k of Kanata.listBackups().reverse()) backupSel.add(new Option(k, k));
}
const downloadSelected = () => { if (backupSel.value) Kanata.downloadBackup(backupSel.value); };
refreshBackups();
