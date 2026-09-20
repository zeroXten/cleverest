"use strict";

/* ---------- constants ---------- */
var EFF = 0.90; // charging efficiency fudge (energy actually delivered)
var CAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l1.6-4.2A2 2 0 0 1 7.5 7.5h9a2 2 0 0 1 1.9 1.3L20 13"/><path d="M4 13h16v4h-2a2 2 0 1 1-4 0H10a2 2 0 1 1-4 0H4z"/></svg>';
var CARS_KEY = "cleverest.cars.v1";
var ACTIVE_KEY = "cleverest.activeCar.v1";
var DEFAULT_CAR = { id: "demo", name: "Demo EV", battery: 64, eff: 4.0, maxkw: 150 };

/* ---------- storage (defensive) ---------- */
function load(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}

/* ---------- state ---------- */
var cars = load(CARS_KEY, null);
if (!Array.isArray(cars) || cars.length === 0) {
  cars = [Object.assign({}, DEFAULT_CAR)];
  save(CARS_KEY, cars);
}
var activeId = load(ACTIVE_KEY, cars[0].id);
if (!cars.some(function (c) { return c.id === activeId; })) activeId = cars[0].id;

function activeCar() {
  return cars.find(function (c) { return c.id === activeId; }) || cars[0];
}

/* ---------- element helpers ---------- */
function $(id) { return document.getElementById(id); }

/* ---------- calculator ---------- */
function fmtTime(mins) {
  mins = Math.round(mins);
  if (mins < 1) return "0 min";
  if (mins < 60) return mins + " min";
  var h = Math.floor(mins / 60), m = mins % 60;
  return m ? h + "h " + m + "m" : h + "h";
}
function pad(n) { return (n < 10 ? "0" : "") + n; }
function clock(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function milesFor(car, pct) { return Math.round(car.battery * pct / 100 * car.eff); }

/* Generic normalised DC charging curve: the fraction of a car's PEAK charge
   rate available at a given state of charge. Real curves differ by model, but
   the shape (near peak through the low-mid range, tapering hard near full) is
   broadly shared — enough to make time estimates far better than a flat rate.
   Scaled by each car's max charge rate, and always capped by the charger. */
var CURVE = [
  [0, 0.60], [5, 0.90], [10, 1.00], [20, 0.98], [30, 0.90], [40, 0.82],
  [50, 0.72], [60, 0.62], [70, 0.50], [80, 0.37], [85, 0.30], [90, 0.22],
  [95, 0.14], [100, 0.07]
];
function curveFactor(soc) {
  if (soc <= CURVE[0][0]) return CURVE[0][1];
  for (var i = 1; i < CURVE.length; i++) {
    if (soc <= CURVE[i][0]) {
      var a = CURVE[i - 1], b = CURVE[i];
      return a[1] + (b[1] - a[1]) * (soc - a[0]) / (b[0] - a[0]);
    }
  }
  return CURVE[CURVE.length - 1][1];
}

/* Minutes to charge from -> to (%) on a charger of chargerKw, integrating the
   curve in 1% steps: dt = dEnergy / power(soc). Power is the lower of the
   charger's output and what the car will accept at that SoC. If the car has no
   max rate set, we fall back to a flat charger-limited rate. */
function chargeMinutes(car, from, to, chargerKw) {
  if (to <= from || chargerKw <= 0) return 0;
  var STEP = 1, dE = car.battery * STEP / 100, mins = 0;
  for (var s = from; s < to; s += STEP) {
    var mid = Math.min(100, s + STEP / 2);
    var power = (car.maxkw && car.maxkw > 0)
      ? Math.min(chargerKw, car.maxkw * curveFactor(mid))
      : chargerKw;
    if (power > 0) mins += (dE / power) * 60;
  }
  return mins / EFF;
}

/* Cap the charger-speed slider at the active car's max rate (no point charging
   faster than the car can take). Falls back to 500 kW if no max is set. */
function updateSpeedRange() {
  var car = activeCar();
  var maxSpeed = (car.maxkw && car.maxkw > 0) ? Math.max(3, Math.round(car.maxkw)) : 500;
  var sp = $("speed");
  sp.max = maxSpeed;
  if (+sp.value > maxSpeed) sp.value = maxSpeed;
  var m1 = Math.round(maxSpeed / 3), m2 = Math.round(maxSpeed * 2 / 3);
  $("speedScale").innerHTML =
    "<span>3</span><span>" + m1 + "</span><span>" + m2 + "</span><span>" + maxSpeed + " kW</span>";
}

function calc() {
  var car = activeCar();
  var now = +$("now").value;
  var tgt = +$("tgt").value;
  var price = +$("price").value;
  var speed = +$("speed").value;
  if (tgt < now) { tgt = now; $("tgt").value = now; }

  var kwh = car.battery * (tgt - now) / 100;
  var mins = chargeMinutes(car, now, tgt, speed);
  var cost = kwh * price / 100;

  $("vNow").innerHTML = now + "% <small>· " + milesFor(car, now) + " mi</small>";
  $("vTgt").innerHTML = tgt + "% <small>· " + milesFor(car, tgt) + " mi</small>";
  $("vSpeed").textContent = speed + " kW";
  $("vPrice").textContent = price + "p /kWh";

  if (kwh <= 0) {
    $("rHeadline").innerHTML = "ALREADY AT " + tgt + "%";
    $("rTime").textContent = "0 min";
    $("rSub").textContent = "nothing to add";
  } else {
    var finish = new Date(Date.now() + Math.round(mins) * 60000);
    $("rHeadline").innerHTML = "READY BY <b>" + clock(finish) + "</b>";
    $("rTime").textContent = fmtTime(mins);
    $("rSub").textContent = now + "% → " + tgt + "% · +" + kwh.toFixed(1) + " kWh";
  }

  $("rRange").textContent = milesFor(car, tgt) + " miles";
  $("rAdded").textContent = "+" + (milesFor(car, tgt) - milesFor(car, now)) + " miles added";
  $("rKwh").textContent = kwh.toFixed(1) + " kWh";
  $("rCost").textContent = "£" + cost.toFixed(2);
}

["now", "tgt", "price", "speed"].forEach(function (id) {
  $(id).addEventListener("input", calc);
});

/* ---------- slider "settle" guard ----------
   On touch, lifting your thumb often nudges the value a few units. Once you've
   settled on a value (held it still for a beat), a small change that happens at
   the instant you release is treated as lift-jitter and snapped back. A
   deliberate move — dragging to a new spot and holding it — is kept. */
function addSettleGuard(slider) {
  var SETTLE_MS = 200;   // held still this long => "settled" on this value
  var LIFT_MS = 220;     // a change this close to release counts as a lift-nudge
  var settled = null;
  var lastChange = 0;
  var timer = null;

  slider.addEventListener("pointerdown", function () {
    settled = +slider.value;                 // where the touch started counts as settled
    lastChange = performance.now();
    clearTimeout(timer);
  });
  slider.addEventListener("input", function () {
    lastChange = performance.now();
    clearTimeout(timer);
    timer = setTimeout(function () { settled = +slider.value; }, SETTLE_MS);
  });

  function release() {
    clearTimeout(timer);
    var jitter = Math.max(1, Math.round((+slider.max - +slider.min) * 0.03)); // ~3% of range
    if (settled != null && +slider.value !== settled &&
        (performance.now() - lastChange) < LIFT_MS &&
        Math.abs(+slider.value - settled) <= jitter) {
      slider.value = settled;
      calc();
    }
    settled = null;
  }
  slider.addEventListener("pointerup", release);
  slider.addEventListener("pointercancel", release);
  slider.addEventListener("touchend", release);
}
["now", "tgt", "price", "speed"].forEach(function (id) { addSettleGuard($(id)); });

/* ---------- header / active car ---------- */
function renderHeader() {
  $("carCurrentName").textContent = activeCar().name;
  $("carCount").textContent = String(cars.length);
}

/* ---------- views ---------- */
function showView(which) {
  $("viewCalc").hidden = which !== "calc";
  $("viewCars").hidden = which !== "cars";
  if (which === "cars") renderCarList();
  window.scrollTo(0, 0);
}
$("carsBtn").addEventListener("click", function () { showView("cars"); });
$("doneBtn").addEventListener("click", function () { showView("calc"); });

/* ---------- cars manager ---------- */
var editingId = null; // null = adding new

function renderCarList() {
  var list = $("carList");
  list.innerHTML = "";
  cars.forEach(function (car) {
    var row = document.createElement("div");
    row.className = "carrow" + (car.id === activeId ? " active" : "");

    var ic = document.createElement("div");
    ic.className = "ic";
    ic.innerHTML = CAR_SVG;

    var meta = document.createElement("button");
    meta.className = "meta carrow-select";
    meta.style.cssText = "background:none;border:none;padding:0;text-align:left;cursor:pointer;color:inherit;font:inherit;min-width:0";
    meta.innerHTML = '<p class="nm"></p><p class="mt"></p>';
    meta.querySelector(".nm").textContent = car.name;
    meta.querySelector(".mt").textContent =
      car.battery + " kWh · " + car.eff + " mi/kWh" + (car.maxkw ? " · " + car.maxkw + " kW" : "");
    meta.addEventListener("click", function () {
      activeId = car.id;
      save(ACTIVE_KEY, activeId);
      renderHeader();
      updateSpeedRange();
      calc();
      showView("calc");
    });

    var right = document.createElement("div");
    right.style.cssText = "flex:none;display:flex;align-items:center;gap:8px";
    if (car.id === activeId) {
      var tick = document.createElement("span");
      tick.className = "tick";
      tick.textContent = "✓ active";
      right.appendChild(tick);
    }
    var edit = document.createElement("button");
    edit.className = "editlink";
    edit.textContent = "Edit";
    edit.addEventListener("click", function (e) { e.stopPropagation(); openEdit(car.id); });
    right.appendChild(edit);

    row.appendChild(ic);
    row.appendChild(meta);
    row.appendChild(right);
    list.appendChild(row);
  });
}

function openEdit(id) {
  editingId = id;
  var car = cars.find(function (c) { return c.id === id; });
  $("editTitle").textContent = "Edit car";
  $("fName").value = car.name;
  $("fBattery").value = car.battery;
  $("fEff").value = car.eff;
  $("fMax").value = car.maxkw || "";
  $("deleteCar").hidden = cars.length <= 1;
  $("formErr").hidden = true;
  $("editCard").hidden = false;
  $("editCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function openAdd() {
  editingId = null;
  $("editTitle").textContent = "Add a car";
  $("fName").value = "";
  $("fBattery").value = "";
  $("fEff").value = "";
  $("fMax").value = "";
  $("deleteCar").hidden = true;
  $("formErr").hidden = true;
  $("editCard").hidden = false;
  $("editCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("fName").focus();
}

$("addCarBtn").addEventListener("click", openAdd);
$("cancelEdit").addEventListener("click", function () { $("editCard").hidden = true; });

function showErr(msg) {
  var el = $("formErr");
  el.textContent = msg;
  el.hidden = false;
}

$("editCard").addEventListener("submit", function (e) {
  e.preventDefault();
  var name = $("fName").value.trim();
  var battery = parseFloat($("fBattery").value);
  var eff = parseFloat($("fEff").value);
  var maxRaw = $("fMax").value.trim();
  var maxkw = maxRaw === "" ? 0 : parseFloat(maxRaw);

  if (!name) return showErr("Give the car a name.");
  if (!(battery > 0)) return showErr("Enter the battery size in kWh.");
  if (!(eff > 0)) return showErr("Enter the efficiency in mi/kWh.");
  if (maxRaw !== "" && !(maxkw > 0)) return showErr("Max charge rate must be a positive number, or leave it blank.");

  if (editingId) {
    var car = cars.find(function (c) { return c.id === editingId; });
    car.name = name; car.battery = battery; car.eff = eff; car.maxkw = maxkw;
  } else {
    var id = "car-" + Date.now().toString(36);
    cars.push({ id: id, name: name, battery: battery, eff: eff, maxkw: maxkw });
    activeId = id; // newly added car becomes active
    save(ACTIVE_KEY, activeId);
  }
  save(CARS_KEY, cars);
  $("editCard").hidden = true;
  renderHeader();
  updateSpeedRange();
  calc();
  renderCarList();
});

$("deleteCar").addEventListener("click", function () {
  if (!editingId || cars.length <= 1) return;
  cars = cars.filter(function (c) { return c.id !== editingId; });
  if (activeId === editingId) { activeId = cars[0].id; save(ACTIVE_KEY, activeId); }
  save(CARS_KEY, cars);
  editingId = null;
  $("editCard").hidden = true;
  renderHeader();
  updateSpeedRange();
  calc();
  renderCarList();
});

/* ---------- PWA: install button ---------- */
var deferredPrompt = null;
var installBtn = $("installBtn");

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone()) installBtn.hidden = false;
});

installBtn.addEventListener("click", function () {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(function () {
    deferredPrompt = null;
    installBtn.hidden = true;
  });
});

window.addEventListener("appinstalled", function () {
  deferredPrompt = null;
  installBtn.hidden = true;
});

/* iOS Safari has no install prompt — show a hint instead */
(function () {
  var ua = window.navigator.userAgent;
  var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (isIOS && !isStandalone()) $("iosHint").hidden = false;
})();

/* ---------- service worker ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  });
}

/* ---------- version + changelog ---------- */
var VERSION = "1.2.1";
var CHANGELOG = [
  { v: "1.2.1", date: "2026-09-20", notes: [
    "Fixed: updates now load reliably — the app was serving cached files after an update"
  ] },
  { v: "1.2.0", date: "2026-09-20", notes: [
    "Charge time now follows a realistic charging curve — power tapers as the battery fills, especially past ~80%",
    "Estimates are most accurate on fast chargers and when charging to a high percentage",
    "New “About” panel explaining how the estimate is worked out"
  ] },
  { v: "1.1.0", date: "2026-09-20", notes: [
    "Sliders now ignore accidental thumb-lift nudges",
    "Version and changelog added to the footer"
  ] },
  { v: "1.0.0", date: "2026-09-20", notes: [
    "Renamed to CLEVEREST",
    "Charger-speed slider capped to each car’s max rate",
    "Price slider range adjusted",
    "Logo and tagline polish"
  ] },
  { v: "0.0.0", date: "2026-09-20", notes: [
    "Initial release — charge time, finish time, cost, and range estimates",
    "Save multiple cars on your device — battery, efficiency, max charge rate",
    "Installable app (PWA) that works offline"
  ] }
];

(function initChangelog() {
  var verBtn = $("verBtn");
  verBtn.textContent = "Version " + VERSION;

  $("clogBody").innerHTML = CHANGELOG.map(function (e) {
    var items = e.notes.map(function (n) { return "<li>" + n + "</li>"; }).join("");
    return '<div class="clog-entry"><p class="clog-ver"><b>' + e.v +
           '</b><span class="date">' + e.date + '</span></p><ul>' + items + "</ul></div>";
  }).join("");

  var modal = $("changelog");
  function onKey(e) { if (e.key === "Escape") close(); }
  function open() { modal.hidden = false; document.addEventListener("keydown", onKey); }
  function close() { modal.hidden = true; document.removeEventListener("keydown", onKey); }
  verBtn.addEventListener("click", open);
  $("clogClose").addEventListener("click", close);
  $("clogBackdrop").addEventListener("click", close);
})();

/* ---------- about ---------- */
(function initAbout() {
  var modal = $("about");
  function onKey(e) { if (e.key === "Escape") close(); }
  function open() { modal.hidden = false; document.addEventListener("keydown", onKey); }
  function close() { modal.hidden = true; document.removeEventListener("keydown", onKey); }
  $("aboutBtn").addEventListener("click", open);
  $("aboutClose").addEventListener("click", close);
  $("aboutBackdrop").addEventListener("click", close);
})();

/* ---------- boot ---------- */
renderHeader();
updateSpeedRange();
calc();
