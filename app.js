"use strict";

/* ---------- constants ---------- */
var EFF = 0.90; // charging efficiency fudge (energy actually delivered)
var CAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l1.6-4.2A2 2 0 0 1 7.5 7.5h9a2 2 0 0 1 1.9 1.3L20 13"/><path d="M4 13h16v4h-2a2 2 0 1 1-4 0H10a2 2 0 1 1-4 0H4z"/></svg>';
var CARS_KEY = "clevercalc.cars.v1";
var ACTIVE_KEY = "clevercalc.activeCar.v1";
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

function calc() {
  var car = activeCar();
  var now = +$("now").value;
  var tgt = +$("tgt").value;
  var price = +$("price").value;
  var speed = +$("speed").value;
  if (tgt < now) { tgt = now; $("tgt").value = now; }

  var kwh = car.battery * (tgt - now) / 100;
  var rate = Math.min(speed, car.maxkw || speed);
  var mins = rate > 0 ? (kwh / rate) / EFF * 60 : 0;
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

/* ---------- boot ---------- */
renderHeader();
calc();
