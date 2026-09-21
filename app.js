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
var CURVE_SOC = [0, 20, 40, 60, 80, 100];                  // evenly spaced state-of-charge anchors (%)
var DEFAULT_CURVE = [0.60, 1.00, 0.82, 0.60, 0.37, 0.07];  // fraction of peak at each anchor (typical shape)

function curveFactor(curve, soc) {
  curve = (curve && curve.length === CURVE_SOC.length) ? curve : DEFAULT_CURVE;
  if (soc <= CURVE_SOC[0]) return curve[0];
  for (var i = 1; i < CURVE_SOC.length; i++) {
    if (soc <= CURVE_SOC[i]) {
      var t = (soc - CURVE_SOC[i - 1]) / (CURVE_SOC[i] - CURVE_SOC[i - 1]);
      return curve[i - 1] + (curve[i] - curve[i - 1]) * t;
    }
  }
  return curve[curve.length - 1];
}

/* Migrate curves saved under the old 5-point layout ([10,35,60,80,100]) to the
   current anchors, by resampling — so nobody loses a custom curve. */
(function migrateCurves() {
  var OLD_SOC = [10, 35, 60, 80, 100];
  if (OLD_SOC.length === CURVE_SOC.length) return;
  function resample(old) {
    return CURVE_SOC.map(function (soc) {
      if (soc <= OLD_SOC[0]) return +old[0].toFixed(3);
      for (var i = 1; i < OLD_SOC.length; i++) {
        if (soc <= OLD_SOC[i]) {
          var t = (soc - OLD_SOC[i - 1]) / (OLD_SOC[i] - OLD_SOC[i - 1]);
          return +(old[i - 1] + (old[i] - old[i - 1]) * t).toFixed(3);
        }
      }
      return +old[old.length - 1].toFixed(3);
    });
  }
  var changed = false;
  cars.forEach(function (c) {
    if (c.curve && c.curve.length === OLD_SOC.length) { c.curve = resample(c.curve); changed = true; }
  });
  if (changed) save(CARS_KEY, cars);
})();

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
      ? Math.min(chargerKw, car.maxkw * curveFactor(car.curve, mid))
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

/* ---- per-car charging-curve editor (drag the points) ---- */
var draftCurve = null;
var CE = { x0: 40, x1: 326, y0: 140, y1: 24 };
var CE_GRAD =
  '<stop offset="0" stop-color="#ff2d95"/><stop offset=".2" stop-color="#ff8a00"/>' +
  '<stop offset=".4" stop-color="#ffe600"/><stop offset=".6" stop-color="#25f4b2"/>' +
  '<stop offset=".8" stop-color="#2ec5ff"/><stop offset="1" stop-color="#8a5cff"/>';
function ceX(soc) { return CE.x0 + (soc / 100) * (CE.x1 - CE.x0); }
function ceY(f) { return CE.y0 - f * (CE.y0 - CE.y1); }
function ceInvY(y) { return (CE.y0 - y) / (CE.y0 - CE.y1); }
function cePeak() { var p = parseFloat($("fMax").value); return p > 0 ? p : 0; }

function renderCurveEditor() {
  var el = $("curveEdit");
  if (!el || !draftCurve) return;
  var grid = "", ylab = "";
  [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
    var gy = ceY(f);
    grid += '<line class="cc-grid" x1="' + CE.x0 + '" y1="' + gy + '" x2="' + CE.x1 + '" y2="' + gy + '"/>';
    ylab += '<text class="ce-ylab" data-f="' + f + '" x="' + (CE.x0 - 6) + '" y="' + (gy + 3) + '"></text>';
  });
  var xlab = "";
  CURVE_SOC.forEach(function (soc) {
    var gx = ceX(soc);
    grid += '<line class="cc-grid" x1="' + gx + '" y1="' + CE.y1 + '" x2="' + gx + '" y2="' + CE.y0 + '"/>';
    xlab += '<text class="cc-xlab" x="' + gx + '" y="' + (CE.y0 + 14) + '">' + soc + '</text>';
  });
  var hits = "", handles = "", vals = "";
  for (var i = 0; i < CURVE_SOC.length; i++) {
    var cx = ceX(CURVE_SOC[i]);
    hits += '<circle class="ce-hit" cx="' + cx + '" r="20"/>';
    handles += '<circle class="ce-handle" cx="' + cx + '" r="6"/>';
    vals += '<text class="ce-val" x="' + cx + '"></text>';
  }
  el.innerHTML =
    '<svg id="ceSvg" viewBox="0 0 340 176" aria-label="Charging curve editor — drag points to set charge power at each state of charge.">' +
      '<defs><linearGradient id="ceg" x1="0" x2="1">' + CE_GRAD + '</linearGradient></defs>' +
      grid + ylab + xlab +
      '<text class="ce-unit" x="' + (CE.x0 - 6) + '" y="' + (CE.y1 - 7) + '"></text>' +
      '<text class="ce-readout" x="' + ((CE.x0 + CE.x1) / 2) + '" y="14"></text>' +
      '<polyline class="ce-line" fill="none" stroke="url(#ceg)" stroke-width="2.5" stroke-linejoin="round"/>' +
      hits + handles + vals +
      '<text class="cc-axis" x="' + ((CE.x0 + CE.x1) / 2) + '" y="174">state of charge (%)</text>' +
    '</svg>';
  updateCurveGraphics();
  wireCurveDrag();
}

function updateCurveGraphics(activeIdx) {
  var svg = $("ceSvg");
  if (!svg || !draftCurve) return;
  var peak = cePeak();

  var pts = [];
  for (var i = 0; i < CURVE_SOC.length; i++) pts.push(ceX(CURVE_SOC[i]) + "," + ceY(draftCurve[i]));
  svg.querySelector(".ce-line").setAttribute("points", pts.join(" "));

  var hd = svg.querySelectorAll(".ce-handle"), ht = svg.querySelectorAll(".ce-hit"), vl = svg.querySelectorAll(".ce-val");
  for (var k = 0; k < CURVE_SOC.length; k++) {
    var f = draftCurve[k], cy = ceY(f);
    hd[k].setAttribute("cy", cy); ht[k].setAttribute("cy", cy);
    vl[k].textContent = peak > 0 ? Math.round(peak * f) : Math.round(f * 100) + "%";
    var ly = cy - 10; if (ly < CE.y1 + 2) ly = cy + 17;
    vl[k].setAttribute("y", ly);
    if (activeIdx === k) vl[k].setAttribute("class", "ce-val active");
    else vl[k].setAttribute("class", "ce-val");
  }

  svg.querySelectorAll(".ce-ylab").forEach(function (t) {
    var f = parseFloat(t.getAttribute("data-f"));
    t.textContent = peak > 0 ? Math.round(peak * f) : Math.round(f * 100);
  });
  var unitEl = svg.querySelector(".ce-unit");
  if (unitEl) unitEl.textContent = peak > 0 ? "kW" : "%";

  var ro = svg.querySelector(".ce-readout");
  if (ro) {
    if (activeIdx != null) {
      var vf = draftCurve[activeIdx];
      ro.textContent = (peak > 0 ? Math.round(peak * vf) + " kW" : Math.round(vf * 100) + "%") +
        " @ " + CURVE_SOC[activeIdx] + "%";
    } else ro.textContent = "";
  }
}

function wireCurveDrag() {
  var svg = $("ceSvg");
  if (!svg) return;
  var active = null;
  function toPoint(e) {
    var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    var loc = p.matrixTransform(svg.getScreenCTM().inverse());
    return { x: loc.x, f: Math.max(0.03, Math.min(1, ceInvY(loc.y))) };
  }
  function nearest(x) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < CURVE_SOC.length; i++) {
      var d = Math.abs(ceX(CURVE_SOC[i]) - x);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  svg.addEventListener("pointerdown", function (e) {
    var t = toPoint(e); active = nearest(t.x);
    draftCurve[active] = +t.f.toFixed(3); updateCurveGraphics(active);
    try { svg.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  svg.addEventListener("pointermove", function (e) {
    if (active === null) return;
    draftCurve[active] = +toPoint(e).f.toFixed(3); updateCurveGraphics(active); e.preventDefault();
  });
  function end() { active = null; updateCurveGraphics(); }
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
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
  draftCurve = (car.curve && car.curve.length === CURVE_SOC.length) ? car.curve.slice() : DEFAULT_CURVE.slice();
  $("editCard").hidden = false;
  renderCurveEditor();
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
  draftCurve = DEFAULT_CURVE.slice();
  $("editCard").hidden = false;
  renderCurveEditor();
  $("editCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("fName").focus();
}

$("addCarBtn").addEventListener("click", openAdd);
$("cancelEdit").addEventListener("click", function () { $("editCard").hidden = true; });
$("curveReset").addEventListener("click", function () { draftCurve = DEFAULT_CURVE.slice(); updateCurveGraphics(); });
$("fMax").addEventListener("input", function () { if (!$("editCard").hidden) updateCurveGraphics(); });

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

  var curve = (draftCurve && draftCurve.length === CURVE_SOC.length) ? draftCurve.slice() : DEFAULT_CURVE.slice();
  if (editingId) {
    var car = cars.find(function (c) { return c.id === editingId; });
    car.name = name; car.battery = battery; car.eff = eff; car.maxkw = maxkw; car.curve = curve;
  } else {
    var id = "car-" + Date.now().toString(36);
    cars.push({ id: id, name: name, battery: battery, eff: eff, maxkw: maxkw, curve: curve });
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
var VERSION = "1.4.3";
var CHANGELOG = [
  { v: "1.4.3", date: "2026-09-21", notes: [
    "Curve editor points are now evenly spaced (0–100%)",
    "A live readout shows the value while you drag, so your finger no longer hides it"
  ] },
  { v: "1.4.2", date: "2026-09-20", notes: [
    "Curve editor now shows power in kW — a labelled axis plus the value above each point — so you're not guessing"
  ] },
  { v: "1.4.1", date: "2026-09-20", notes: [
    "About panel now shows your active car's actual curve (default or custom) and explains you can adjust it"
  ] },
  { v: "1.4.0", date: "2026-09-20", notes: [
    "Adjustable charging curve per car — drag the points to match your model for a sharper estimate",
    "Look up your car's real curve via EVKX or EV Database (links in the car editor)"
  ] },
  { v: "1.3.1", date: "2026-09-20", notes: [
    "About panel now explains the formula and shows the charging-curve chart",
    "Clearer about what the estimate can't know (your exact curve, temperature, preconditioning)"
  ] },
  { v: "1.3.0", date: "2026-09-20", notes: [
    "Added anonymous, cookie-free usage stats (GoatCounter) — no personal data",
    "Your cars and settings still stay only on your device"
  ] },
  { v: "1.2.2", date: "2026-09-20", notes: [
    "Logo now shows the cleverest.autos web address"
  ] },
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

/* Draw the generic charging curve (normalised power vs SoC) into the About
   panel, straight from the same CURVE data the calculator uses. */
function drawCurveChart() {
  var el = $("curveChart");
  if (!el) return;
  var car = activeCar();
  var W = 340, H = 190, pl = 34, pr = 10, pt = 12, pb = 26;
  var x0 = pl, x1 = W - pr, y0 = H - pb, y1 = pt;
  function X(soc) { return x0 + (soc / 100) * (x1 - x0); }
  function Y(f) { return y0 - f * (y0 - y1); }

  var pts = [];
  for (var s = 0; s <= 100; s += 2) pts.push(X(s).toFixed(1) + "," + Y(curveFactor(car.curve, s)).toFixed(1));

  var grid = "";
  [0, 25, 50, 75, 100].forEach(function (g) {
    grid += '<line class="cc-grid" x1="' + X(g) + '" y1="' + y1 + '" x2="' + X(g) + '" y2="' + y0 + '"/>' +
            '<text class="cc-xlab" x="' + X(g) + '" y="' + (y0 + 14) + '">' + g + '</text>';
  });
  [0, 0.5, 1].forEach(function (f) {
    grid += '<line class="cc-grid" x1="' + x0 + '" y1="' + Y(f) + '" x2="' + x1 + '" y2="' + Y(f) + '"/>' +
            '<text class="cc-ylab" x="' + (x0 - 6) + '" y="' + (Y(f) + 3) + '">' + Math.round(f * 100) + '</text>';
  });

  el.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Typical charging curve: power as a percentage of the car\'s peak versus state of charge. Near peak in the low-to-mid range, tapering steeply toward full.">' +
      '<defs><linearGradient id="ccg" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#ff2d95"/><stop offset=".2" stop-color="#ff8a00"/>' +
        '<stop offset=".4" stop-color="#ffe600"/><stop offset=".6" stop-color="#25f4b2"/>' +
        '<stop offset=".8" stop-color="#2ec5ff"/><stop offset="1" stop-color="#8a5cff"/>' +
      '</linearGradient></defs>' +
      grid +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="url(#ccg)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<text class="cc-axis" x="' + ((x0 + x1) / 2) + '" y="' + (H - 1) + '">state of charge (%)</text>' +
      '<text class="cc-axis" transform="translate(9,' + ((y0 + y1) / 2) + ') rotate(-90)">power (% of peak)</text>' +
    '</svg>';

  var cap = $("curveChartCap");
  if (cap) {
    var custom = car.curve && car.curve.length === CURVE_SOC.length &&
      car.curve.some(function (v, i) { return Math.abs(v - DEFAULT_CURVE[i]) > 0.001; });
    cap.textContent = car.name + " — " + (custom ? "your custom curve" : "typical default curve");
  }
}

/* ---------- about ---------- */
(function initAbout() {
  var modal = $("about");
  function onKey(e) { if (e.key === "Escape") close(); }
  function open() { drawCurveChart(); modal.hidden = false; document.addEventListener("keydown", onKey); }
  function close() { modal.hidden = true; document.removeEventListener("keydown", onKey); }
  $("aboutBtn").addEventListener("click", open);
  $("aboutClose").addEventListener("click", close);
  $("aboutBackdrop").addEventListener("click", close);
})();

/* ---------- boot ---------- */
renderHeader();
updateSpeedRange();
calc();
