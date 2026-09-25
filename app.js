"use strict";

/* ---------- constants ---------- */
var EFF = 0.90; // charging efficiency fudge (energy actually delivered)
var CAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13l1.6-4.2A2 2 0 0 1 7.5 7.5h9a2 2 0 0 1 1.9 1.3L20 13"/><path d="M4 13h16v4h-2a2 2 0 1 1-4 0H10a2 2 0 1 1-4 0H4z"/></svg>';
var BOLT_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13 2 4 13h6l-1 9 9-12h-6z"/></svg>';
var CARS_KEY = "cleverest.cars.v1";
var ACTIVE_KEY = "cleverest.activeCar.v1";
// maxkw is the car's DC (rapid) limit. acSingle / acThree are the onboard AC
// charging limits (kW) on a single-phase and a three-phase supply.
var DEFAULT_CAR = { id: "demo", name: "Demo EV", battery: 64, eff: 4.0, maxkw: 150, acSingle: 7, acThree: 11 };
var CHARGERS_KEY = "cleverest.chargers.v1";
var ACTIVE_CHARGER_KEY = "cleverest.activeCharger.v1";
// type: "AC" | "DC". phase (AC only): "single" | "three".
var DEFAULT_CHARGERS = [
  { id: "home", name: "Home 7kW", kw: 7, price: 7, type: "AC", phase: "single" },
  { id: "rapid", name: "Public rapid 50kW", kw: 50, price: 45, type: "DC", phase: "single" }
];
var SESSIONS_KEY = "cleverest.sessions.v1";
var MAX_SESSIONS = 50;          // rolling window; oldest dropped past this
var HALF_LIFE_DAYS = 30;        // a session's calibration weight halves every 30 days
var SHRINK_K = 1;               // shrinkage: sparse/old data stays near uncorrected

// A charger is AC at or below this power, DC above it (rare exceptions overridable).
var AC_DC_THRESHOLD = 22;
function inferType(kw) { return kw > AC_DC_THRESHOLD ? "DC" : "AC"; }

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

/* ---------- preferences: units + currency ---------- */
var PREFS_KEY = "cleverest.prefs.v1";
var CURRENCIES = { GBP: { symbol: "£", minor: "p" }, EUR: { symbol: "€", minor: "c" }, USD: { symbol: "$", minor: "¢" } };
var KM_PER_MI = 1.609344;

function detectPrefs() {
  var loc = (navigator.languages && navigator.languages[0]) || navigator.language || "en-GB";
  var region = "";
  try { region = new Intl.Locale(loc).maximize().region || ""; }
  catch (e) { var m = /[-_]([A-Za-z]{2})\b/.exec(loc); region = m ? m[1] : ""; }
  region = region.toUpperCase();
  var euro = { AT:1,BE:1,HR:1,CY:1,EE:1,FI:1,FR:1,DE:1,GR:1,IE:1,IT:1,LV:1,LT:1,LU:1,MT:1,NL:1,PT:1,SK:1,SI:1,ES:1 };
  return {
    unit: (region === "GB" || region === "US") ? "mi" : "km",
    currency: region === "GB" ? "GBP" : (euro[region] ? "EUR" : "USD"),
    priceMax: 150
  };
}

var prefs = load(PREFS_KEY, null);
if (!prefs || !CURRENCIES[prefs.currency] || (prefs.unit !== "mi" && prefs.unit !== "km")) {
  prefs = detectPrefs();
  save(PREFS_KEY, prefs);
}
if (!(prefs.priceMax > 0)) { prefs.priceMax = 150; save(PREFS_KEY, prefs); }

function cur() { return CURRENCIES[prefs.currency]; }
function isKm() { return prefs.unit === "km"; }
function distUnit() { return isKm() ? "km" : "mi"; }
function distWord() { return isKm() ? "km" : "miles"; }
function toDisp(mi) { return isKm() ? mi * KM_PER_MI : mi; }          // internal miles -> display distance
function toDispEff(effMi) { return isKm() ? effMi * KM_PER_MI : effMi; } // internal mi/kWh -> display eff
function fromDispEff(v) { return isKm() ? v / KM_PER_MI : v; }        // display eff -> internal mi/kWh
function money(v) { return cur().symbol + v.toFixed(2); }             // v in major units
function round1(n) { return Math.round(n * 10) / 10; }
function fmtEff(effMi) { return round1(toDispEff(effMi)) + (isKm() ? " km/kWh" : " mi/kWh"); }

/* ---------- state ---------- */
var cars = load(CARS_KEY, null);
if (!Array.isArray(cars) || cars.length === 0) {
  cars = [Object.assign({}, DEFAULT_CAR)];
  save(CARS_KEY, cars);
}
var activeId = load(ACTIVE_KEY, cars[0].id);
if (!cars.some(function (c) { return c.id === activeId; })) activeId = cars[0].id;

var chargers = load(CHARGERS_KEY, null);
if (!Array.isArray(chargers)) {
  chargers = DEFAULT_CHARGERS.map(function (c) { return Object.assign({}, c); });
  save(CHARGERS_KEY, chargers);
}
var activeChargerId = load(ACTIVE_CHARGER_KEY, null);

/* Migrate saved chargers to carry an AC/DC type (and AC phase). Existing
   chargers are typed from their power with the same rule new ones default to. */
(function migrateChargers() {
  var changed = false;
  chargers.forEach(function (c) {
    if (c.type !== "AC" && c.type !== "DC") { c.type = inferType(c.kw); changed = true; }
    if (c.type === "AC" && c.phase !== "single" && c.phase !== "three") { c.phase = "single"; changed = true; }
  });
  if (changed) save(CHARGERS_KEY, chargers);
})();

var sessions = load(SESSIONS_KEY, []);
if (!Array.isArray(sessions)) sessions = [];

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

/* The car's AC charging limit (kW) for a given phase, or null if unknown (in
   which case AC charging is limited only by the charger). Three-phase falls
   back to the single-phase figure if not separately set. */
function acLimit(car, phase) {
  var single = (car.acSingle > 0) ? car.acSingle : 0;
  var three = (car.acThree > 0) ? car.acThree : single;
  var lim = (phase === "three") ? three : single;
  return lim > 0 ? lim : null;
}

/* Base (uncorrected) minutes to charge from -> to (%). Charger is an object
   { kw, type, phase }.
   DC: integrate the car's charging curve in 1% steps, power capped by the lower
       of the charger's output and the car's DC limit at that SoC (curve shape).
   AC: onboard charger is the bottleneck, so charge at a flat rate = the lower of
       the charger's output and the car's AC limit for that phase (no curve). */
function baseMinutes(car, from, to, charger) {
  if (to <= from || !(charger.kw > 0)) return 0;

  if (charger.type === "AC") {
    var lim = acLimit(car, charger.phase);
    var rate = lim ? Math.min(charger.kw, lim) : charger.kw;
    if (!(rate > 0)) return 0;
    var energy = car.battery * (to - from) / 100;
    return energy / rate / EFF * 60;
  }

  return dcIntegrate(car, from, to, charger.kw, null);
}

/* Integrate DC charge time over [from,to] in 1% steps. mAt, if given, is a
   function(soc) returning a per-step time multiplier — used to apply a
   SoC-band-aware calibration that reshapes the curve rather than just scaling it. */
function dcIntegrate(car, from, to, chargerKw, mAt) {
  if (to <= from || !(chargerKw > 0)) return 0;
  var STEP = 1, dE = car.battery * STEP / 100, mins = 0;
  for (var s = from; s < to; s += STEP) {
    var mid = Math.min(100, s + STEP / 2);
    var power = (car.maxkw && car.maxkw > 0)
      ? Math.min(chargerKw, car.maxkw * curveFactor(car.curve, mid))
      : chargerKw;
    if (power > 0) {
      var dt = (dE / power) * 60 / EFF;
      mins += mAt ? dt * mAt(mid) : dt;
    }
  }
  return mins;
}

/* ---------- SoC-band-aware DC time calibration ---------- */
var DC_BANDS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];  // ten even 10% bands
var BAND_LAMBDA = 0.3;                  // ridge shrinkage of each band toward the flat factor

function bandIndex(soc) {
  for (var i = 1; i < DC_BANDS.length; i++) { if (soc <= DC_BANDS[i]) return i - 1; }
  return DC_BANDS.length - 2;
}
function bandCount() { return DC_BANDS.length - 1; }

/* Fraction of a DC charge's predicted time that falls in each SoC band, for the
   given range/charger. Stored on a session at log time so the deconvolution
   stays consistent even if the car or charger is later edited. */
function bandFractions(car, from, to, chargerKw) {
  var B = bandCount(), mins = [], total = 0, s, i;
  for (i = 0; i < B; i++) mins.push(0);
  var STEP = 1, dE = car.battery * STEP / 100;
  for (s = from; s < to; s += STEP) {
    var mid = Math.min(100, s + STEP / 2);
    var power = (car.maxkw && car.maxkw > 0)
      ? Math.min(chargerKw, car.maxkw * curveFactor(car.curve, mid))
      : chargerKw;
    if (power > 0) { var dt = (dE / power) * 60 / EFF; mins[bandIndex(mid)] += dt; total += dt; }
  }
  if (!(total > 0)) return null;
  return mins.map(function (m) { return m / total; });
}

/* Solve the small linear system A x = b (Gauss-Jordan, partial pivot). */
function solveLinear(A, b) {
  var n = b.length, M = A.map(function (row, i) { return row.slice().concat([b[i]]); });
  for (var col = 0; col < n; col++) {
    var piv = col, r, j;
    for (r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-9) return null;
    var t = M[col]; M[col] = M[piv]; M[piv] = t;
    var pv = M[col][col];
    for (j = col; j <= n; j++) M[col][j] /= pv;
    for (r = 0; r < n; r++) if (r !== col) { var f = M[r][col]; for (j = col; j <= n; j++) M[r][j] -= f * M[col][j]; }
  }
  return M.map(function (row) { return row[n]; });
}

/* Learn per-band DC time multipliers by ridge-regularised deconvolution of the
   logged sessions: each session constrains a weighted sum of its bands' factors
   to equal its overall actual/predicted ratio. Bands with little coverage are
   pulled back to the flat DC factor, so sparse data reshapes nothing. Returns
   { bands: [m0..], g } — bands is null when there's nothing to fit. */
function dcBandMultipliers(carId) {
  var g = timeCorrection(carId, "DC");
  var B = bandCount();
  var rows = sessions.filter(function (s) {
    return s.carId === carId && s.type === "DC" && s.predMins > 0 && s.actualMins > 0 &&
      Array.isArray(s.bands) && s.bands.length === B;
  }).map(function (s) {
    return { f: s.bands, r: s.actualMins / s.predMins, w: sessionWeight(s.date) };
  });
  if (!rows.length) return { bands: null, g: g, cov: null };

  var F = [], c = [], cov = [], a, b;
  for (a = 0; a < B; a++) { F.push(new Array(B).fill(0)); c.push(0); cov.push(0); }
  rows.forEach(function (row) {
    for (a = 0; a < B; a++) {
      cov[a] += row.w * row.f[a];               // effective weighted coverage of this band
      c[a] += row.w * row.f[a] * row.r;
      for (b = 0; b < B; b++) F[a][b] += row.w * row.f[a] * row.f[b];
    }
  });
  for (a = 0; a < B; a++) { F[a][a] += BAND_LAMBDA; c[a] += BAND_LAMBDA * g; }

  var m = solveLinear(F, c);
  if (!m) return { bands: null, g: g, cov: null };
  m = m.map(function (x) { return Math.max(0.5, Math.min(2, x)); });
  return { bands: m, g: g, cov: cov };
}

// A band counts as "charged through" (worth drawing) above this effective coverage.
var BAND_COV_MIN = 0.08;

/* Final corrected DC minutes: reshape the curve with the band multipliers (or
   the flat factor when unfitted), then apply the current-temperature factor. */
function dcEstimateMinutes(car, from, to, chargerKw, temp) {
  var mult = dcBandMultipliers(car.id);
  var mAt = function (soc) { return mult.bands ? mult.bands[bandIndex(soc)] : mult.g; };
  return dcIntegrate(car, from, to, chargerKw, mAt) * dcTempFactor(car.id, temp);
}

/* Unified corrected estimate for any charger, temperature-aware for DC. */
function estimateMinutes(car, from, to, charger, temp) {
  if (charger.type === "AC") return baseMinutes(car, from, to, charger) * timeCorrection(car.id, "AC");
  return dcEstimateMinutes(car, from, to, charger.kw, temp);
}

/* Backfill per-band predicted-time fractions on older DC sessions (logged before
   this data existed, or under a different band layout) so they feed the per-band
   chart, not just the overall factor. Recomputes from the session's stored range
   using its car and the charger power it recorded (or the charger's current kW). */
(function migrateSessionBands() {
  var B = bandCount(), changed = false;
  sessions.forEach(function (s) {
    if (s.type !== "DC") return;
    if (Array.isArray(s.bands) && s.bands.length === B) return;
    var car = cars.find(function (c) { return c.id === s.carId; });
    var kw = (s.chargerKw > 0) ? s.chargerKw : (function () {
      var c = chargers.find(function (x) { return x.id === s.chargerId; });
      return c ? c.kw : 0;
    })();
    if (car && kw > 0 && s.fromPct != null && s.toPct != null && s.toPct > s.fromPct) {
      var bands = bandFractions(car, s.fromPct, s.toPct, kw);
      if (bands) { s.bands = bands; if (!(s.chargerKw > 0)) s.chargerKw = kw; changed = true; }
    }
  });
  if (changed) save(SESSIONS_KEY, sessions);
})();

/* ---------- calibration from logged sessions ---------- */
/* Recency weight for a session: halves every HALF_LIFE_DAYS. */
function sessionWeight(iso) {
  var age = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (!(age >= 0)) age = 0;
  return Math.pow(0.5, age / HALF_LIFE_DAYS);
}

/* Weighted, shrunk correction factor from a list of { ratio, iso } pairs, where
   ratio = actual / predicted. With little or old data the factor stays close to
   1 (uncorrected); it approaches the recency-weighted mean ratio only once
   several fresh sessions have accumulated. Clamped to a sane range. */
function shrunkCorrection(pairs) {
  var W = 0, WR = 0;
  pairs.forEach(function (p) {
    if (!(p.ratio > 0) || !isFinite(p.ratio)) return;
    var w = sessionWeight(p.iso);
    W += w; WR += w * p.ratio;
  });
  if (W <= 0) return 1;
  var R = WR / W;                       // recency-weighted mean ratio
  var f = 1 + (R - 1) * (W / (W + SHRINK_K));
  return Math.max(0.5, Math.min(2, f));
}

/* Time correction is per car, split by charger type (AC barely temperature-
   affected, DC heavily) so the two don't contaminate each other. */
function timeCorrection(carId, type) {
  return shrunkCorrection(sessions
    .filter(function (s) { return s.carId === carId && s.type === type && s.predMins > 0 && s.actualMins > 0; })
    .map(function (s) { return { ratio: s.actualMins / s.predMins, iso: s.date }; }));
}

/* Cost correction is per charger/network (tariff changes), independent of car.
   When a session logged the actual energy delivered, the ratio is real price-
   per-kWh vs the price you set — isolating tariff drift from any error in the
   predicted energy. Otherwise it falls back to the total actual-vs-predicted cost. */
function costCorrection(chargerId) {
  if (!chargerId) return 1;
  return shrunkCorrection(sessions
    .filter(function (s) { return s.chargerId === chargerId && s.predCost > 0 && s.actualCost > 0; })
    .map(function (s) {
      if (s.actualKwh > 0 && s.predKwh > 0) {
        var setPerKwh = s.predCost / s.predKwh;        // the price you set (= price/100 at log time)
        var realPerKwh = s.actualCost / s.actualKwh;   // what you actually paid per kWh
        return { ratio: realPerKwh / setPerKwh, iso: s.date };
      }
      return { ratio: s.actualCost / s.predCost, iso: s.date };
    }));
}

function countSessions(carId, type) {
  return sessions.filter(function (s) { return s.carId === carId && s.type === type; }).length;
}

/* ---------- temperature-aware DC time ---------- */
var TEMP_SLOPE_K = 4;        // shrinkage: need several temp-tagged sessions to trust a slope
var TEMP_SLOPE_CAP = 0.06;   // clamp the learned sensitivity to ~6% of time per °C

/* How much colder ambient temperatures stretch this car's DC charge time, learnt
   from logged DC sessions that recorded a temperature. Returns a multiplier on
   the plain DC time correction for a given current temperature. Centred on the
   (recency-weighted) mean logged temp so it's 1 there, and heavily shrunk so it
   stays ~1 until several temperature-tagged sessions exist. AC is unaffected. */
function dcTempFactor(carId, temp) {
  if (temp == null || isNaN(temp)) return 1;
  var base = timeCorrection(carId, "DC");
  if (!(base > 0)) return 1;
  var rows = sessions.filter(function (s) {
    return s.carId === carId && s.type === "DC" && s.predMins > 0 && s.actualMins > 0 && s.temp != null && !isNaN(s.temp);
  }).map(function (s) {
    return { t: +s.temp, y: Math.log((s.actualMins / s.predMins) / base), w: sessionWeight(s.date) };
  });
  if (rows.length < 2) return 1;
  var W = 0, WT = 0;
  rows.forEach(function (r) { W += r.w; WT += r.w * r.t; });
  if (!(W > 0)) return 1;
  var tMean = WT / W;
  var num = 0, den = 0; // weighted slope of y on x=(tMean - t), through the centred origin
  rows.forEach(function (r) { var x = tMean - r.t; num += r.w * x * r.y; den += r.w * x * x; });
  if (!(den > 0)) return 1;
  var slope = (num / den) * (W / (W + TEMP_SLOPE_K));
  slope = Math.max(-TEMP_SLOPE_CAP, Math.min(TEMP_SLOPE_CAP, slope));
  return Math.max(0.6, Math.min(1.8, Math.exp(slope * (tMean - temp))));
}

/* Current ambient temperature from the main-screen field, or null if blank. */
function currentAmbient() {
  var el = $("ambient");
  if (!el) return null;
  var v = el.value.trim();
  if (v === "") return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
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
    "<span>" + sp.min + "</span><span>" + m1 + "</span><span>" + m2 + "</span><span>" + maxSpeed + " kW</span>";
}

/* The charger the main screen is currently estimating with: a saved charger's
   type/phase when one is selected, otherwise inferred from the speed slider. kw
   always tracks the (car-capped) speed slider. */
function currentCharger() {
  // A selected saved charger uses its exact stored kW (so low-power chargers like
  // a 1.2 kW granny lead aren't lost to the slider's rounding); a custom/dragged
  // charger uses the slider value and infers its type from the power.
  var c = chargers.find(function (x) { return x.id === activeChargerId; });
  if (c) {
    var cap = +$("speed").max;                       // the car's max charge rate
    return { id: c.id, kw: Math.min(c.kw, cap), type: c.type, phase: c.phase || "single" };
  }
  var kw = +$("speed").value;
  return { id: null, kw: kw, type: inferType(kw), phase: "single" };
}

/* Human label for a charger's type, e.g. "DC rapid" or "AC · 1-phase". */
function typeLabel(charger) {
  if (charger.type === "AC") return "AC · " + (charger.phase === "three" ? "3-phase" : "1-phase");
  return "DC rapid";
}

function calc() {
  var car = activeCar();
  var now = +$("now").value;
  var tgt = +$("tgt").value;
  var price = +$("price").value;
  if (tgt < now) { tgt = now; $("tgt").value = now; }

  var charger = currentCharger();
  var kwh = car.battery * (tgt - now) / 100;
  var af = $("ambientField");
  if (af) af.hidden = (charger.type !== "DC");
  var ambient = currentAmbient();
  var va = $("vAmbient");
  if (va) va.textContent = (charger.type === "DC" && ambient != null) ? ambient + "°C" : "";
  var baseM = baseMinutes(car, now, tgt, charger);
  var mins = estimateMinutes(car, now, tgt, charger, ambient);
  var cCorr = costCorrection(charger.id);
  var cost = kwh * price / 100 * cCorr;

  $("vNow").innerHTML = now + "% <small>· " + Math.round(toDisp(milesFor(car, now))) + " " + distUnit() + "</small>";
  $("vTgt").innerHTML = tgt + "% <small>· " + Math.round(toDisp(milesFor(car, tgt))) + " " + distUnit() + "</small>";
  $("vSpeed").textContent = round1(charger.kw) + " kW";
  $("vPrice").textContent = price + cur().minor + " /kWh";
  var ct = $("chargerType");
  if (ct) {
    var timeCal = baseM > 0 && Math.abs(mins / baseM - 1) > 0.005;
    var calibrated = timeCal || Math.abs(cCorr - 1) > 0.005;
    ct.textContent = typeLabel(charger) + (calibrated ? " · calibrated" : "");
  }

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

  var rngTgt = Math.round(toDisp(milesFor(car, tgt)));
  var rngNow = Math.round(toDisp(milesFor(car, now)));
  $("rRange").textContent = rngTgt + " " + distWord();
  $("rAdded").textContent = "+" + (rngTgt - rngNow) + " " + distWord() + " added";
  $("rKwh").textContent = kwh.toFixed(1) + " kWh";
  $("rCost").textContent = money(cost);

  var addedDisp = toDisp(car.battery * Math.max(0, tgt - now) / 100 * car.eff); // display-distance added
  $("rPerDistLabel").textContent = "Per " + distUnit();
  $("rPerDist").textContent = addedDisp > 0 ? round1(cost / addedDisp * 100) + cur().minor + "/" + distUnit() : "—";

  renderCompare();
}

["now", "tgt", "price", "speed"].forEach(function (id) {
  $(id).addEventListener("input", calc);
});
$("ambient").addEventListener("input", calc);

/* ---------- slider "settle" guard ----------
   On touch, lifting your thumb often nudges the value a few units. Once you've
   settled on a value (held it still for a beat), a small change that happens at
   the instant you release is treated as lift-jitter and snapped back. A
   deliberate move — dragging to a new spot and holding it — is kept. */
function addSettleGuard(slider, onSnap) {
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
      (onSnap || calc)();
    }
    settled = null;
  }
  slider.addEventListener("pointerup", release);
  slider.addEventListener("pointercancel", release);
  slider.addEventListener("touchend", release);
}
["now", "tgt", "price", "speed"].forEach(function (id) { addSettleGuard($(id)); });
["sFrom", "sTo", "sMins"].forEach(function (id) { addSettleGuard($(id), updateSessSliders); });

/* ---------- header / active car ---------- */
function renderHeader() {
  var el = $("mCarCount"); if (el) el.textContent = String(cars.length);
}

/* Car selection chips on the main screen (configuration lives on the Cars page). */
function renderCarChips() {
  var wrap = $("carChips");
  if (!wrap) return;
  wrap.innerHTML = "";
  cars.forEach(function (c) {
    var b = document.createElement("button");
    b.className = "chip" + (c.id === activeId ? " active" : "");
    b.textContent = c.name;
    b.addEventListener("click", function () { selectCar(c.id); });
    wrap.appendChild(b);
  });
}

function selectCar(id) {
  activeId = id;
  save(ACTIVE_KEY, activeId);
  renderHeader();
  renderCarChips();
  updateSpeedRange();
  calc();
}

/* ---------- views ---------- */
function showView(which) {
  $("viewCalc").hidden = which !== "calc";
  $("viewCars").hidden = which !== "cars";
  $("viewChargers").hidden = which !== "chargers";
  $("viewSessions").hidden = which !== "sessions";
  $("viewPrefs").hidden = which !== "prefs";
  if (which === "cars") renderCarList();
  if (which === "chargers") renderChargerList();
  if (which === "sessions") renderSessions();
  if (which === "prefs") renderPrefs();
  window.scrollTo(0, 0);
}
$("doneBtn").addEventListener("click", function () { showView("calc"); });
$("chgDoneBtn").addEventListener("click", function () { showView("calc"); });
$("sessDoneBtn").addEventListener("click", function () { showView("calc"); });
$("prefsDoneBtn").addEventListener("click", function () { showView("calc"); });

/* ---------- hamburger menu ---------- */
function closeMenu() { $("menuSheet").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false"); }
$("menuBtn").addEventListener("click", function (e) {
  e.stopPropagation();
  var willOpen = $("menuSheet").hidden;
  $("menuSheet").hidden = !willOpen;
  $("menuBtn").setAttribute("aria-expanded", String(willOpen));
});
$("menuSheet").addEventListener("click", function (e) {
  var b = e.target.closest(".menu-item"); if (!b) return;
  var go = b.getAttribute("data-go");
  closeMenu();
  if (go === "about") openAbout();
  else if (go === "update") checkForUpdates();
  else showView(go);
});
document.addEventListener("click", function (e) {
  if (!$("menuSheet").hidden && !e.target.closest(".menu")) closeMenu();
});
document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenu(); });

/* ---------- preferences ---------- */
function applyPriceMax() {
  var sp = $("price");
  sp.max = prefs.priceMax;
  if (+sp.value > prefs.priceMax) sp.value = prefs.priceMax;
  var pm = $("priceMax"); if (pm) pm.textContent = prefs.priceMax + cur().minor;
}
function renderPrefs() {
  Array.prototype.forEach.call($("segUnit").children, function (b) { b.classList.toggle("on", b.getAttribute("data-v") === prefs.unit); });
  Array.prototype.forEach.call($("segCurrency").children, function (b) { b.classList.toggle("on", b.getAttribute("data-v") === prefs.currency); });
  $("fPriceMax").value = prefs.priceMax;
  $("fPriceMaxUnit").textContent = cur().minor + "/kWh";
}
function refreshUnits() {
  applyPriceMax();
  calc();
  renderCarList();
  renderChargerList();
}
$("segUnit").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  prefs.unit = b.getAttribute("data-v"); save(PREFS_KEY, prefs); renderPrefs(); refreshUnits();
});
$("segCurrency").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  prefs.currency = b.getAttribute("data-v"); save(PREFS_KEY, prefs); renderPrefs(); refreshUnits();
});
$("fPriceMax").addEventListener("input", function () {
  var v = parseInt(this.value, 10);
  if (v >= 1) { prefs.priceMax = v; save(PREFS_KEY, prefs); applyPriceMax(); calc(); }
});

/* ---------- backup: export / import JSON ---------- */
function exportData() {
  var data = {
    app: "cleverest", version: VERSION, exported: new Date().toISOString(),
    cars: load(CARS_KEY, []), activeCar: load(ACTIVE_KEY, null),
    chargers: load(CHARGERS_KEY, []), activeCharger: load(ACTIVE_CHARGER_KEY, null),
    sessions: load(SESSIONS_KEY, []),
    prefs: load(PREFS_KEY, null)
  };
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "cleverest-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function applyImport(data) {
  if (!data || !Array.isArray(data.cars) || !data.cars.length) return false;
  save(CARS_KEY, data.cars);
  if (data.activeCar) save(ACTIVE_KEY, data.activeCar);
  if (Array.isArray(data.chargers)) save(CHARGERS_KEY, data.chargers);
  if ("activeCharger" in data) save(ACTIVE_CHARGER_KEY, data.activeCharger);
  if (Array.isArray(data.sessions)) save(SESSIONS_KEY, data.sessions);
  if (data.prefs) save(PREFS_KEY, data.prefs);
  return true;
}

var pendingImport = null;

$("exportBtn").addEventListener("click", exportData);
$("importBtn").addEventListener("click", function () {
  pendingImport = null;
  $("importErr").hidden = true;
  $("importConfirm").hidden = true;
  $("importFile").value = "";
  $("importFile").click();
});
$("importFile").addEventListener("change", function () {
  var file = this.files && this.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var data = null;
    try { data = JSON.parse(reader.result); } catch (e) {}
    if (!data || !Array.isArray(data.cars) || !data.cars.length) {
      pendingImport = null;
      $("importConfirm").hidden = true;
      $("importErr").textContent = "That doesn't look like a CLEVEREST backup file.";
      $("importErr").hidden = false;
      return;
    }
    pendingImport = data;
    $("importErr").hidden = true;
    $("importConfirmMsg").textContent = "Replace your data with “" + file.name + "”? This can't be undone.";
    $("importConfirm").hidden = false;
    $("importConfirm").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  reader.readAsText(file);
});
$("importYes").addEventListener("click", function () {
  if (pendingImport && applyImport(pendingImport)) location.reload();
});
$("importNo").addEventListener("click", function () {
  pendingImport = null;
  $("importConfirm").hidden = true;
  $("importFile").value = "";
});

/* ---------- reordering (shared) ---------- */
function gripHandle() {
  var g = document.createElement("div");
  g.className = "grip";
  g.setAttribute("aria-label", "Drag to reorder");
  g.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';
  return g;
}

/* Drag-to-reorder for a list of .carrow rows (each carries data-id). Delegated,
   so it survives re-renders. Works with touch and mouse via pointer events. */
function wireDragReorder(listEl, getArr, onReorder) {
  var dragEl = null, baseY = 0;
  var LIFT = " scale(1.03)";

  listEl.addEventListener("pointerdown", function (e) {
    var grip = e.target.closest(".grip");
    if (!grip || !listEl.contains(grip)) return;
    dragEl = grip.closest(".carrow");
    if (!dragEl) return;
    baseY = e.clientY;
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    dragEl.classList.add("dragging");
    listEl.classList.add("reordering");
    dragEl.style.transform = LIFT.trim();
    e.preventDefault();
  });

  listEl.addEventListener("pointermove", function (e) {
    if (!dragEl) return;
    e.preventDefault();
    var y = e.clientY;
    var rows = Array.prototype.slice.call(listEl.querySelectorAll(".carrow"));
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r === dragEl) continue;
      var rect = r.getBoundingClientRect();
      if (y < rect.top + rect.height / 2) { target = r; break; }
    }
    var reordered = false;
    if (target) {
      if (dragEl.nextElementSibling !== target) { listEl.insertBefore(dragEl, target); reordered = true; }
    } else if (listEl.lastElementChild !== dragEl) {
      listEl.appendChild(dragEl); reordered = true;
    }
    if (reordered) { baseY = y; dragEl.style.transform = LIFT.trim(); }
    else { dragEl.style.transform = "translateY(" + (y - baseY) + "px)" + LIFT; }
  });

  function end() {
    if (!dragEl) return;
    dragEl.style.transform = "";
    dragEl.classList.remove("dragging");
    listEl.classList.remove("reordering");
    dragEl = null;
    var ids = Array.prototype.slice.call(listEl.querySelectorAll(".carrow")).map(function (r) { return r.getAttribute("data-id"); });
    getArr().sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });
    onReorder();
  }
  listEl.addEventListener("pointerup", end);
  listEl.addEventListener("pointercancel", end);
}

function carsChanged() { save(CARS_KEY, cars); renderCarChips(); renderCarList(); }
function chargersChanged() { save(CHARGERS_KEY, chargers); renderChargerChips(); renderCompare(); renderChargerList(); }

/* ---------- cars manager ---------- */
var editingId = null; // null = adding new

function renderCarList() {
  var list = $("carList");
  list.innerHTML = "";
  cars.forEach(function (car, i) {
    var row = document.createElement("div");
    row.className = "carrow" + (car.id === activeId ? " active" : "");
    row.setAttribute("data-id", car.id);

    var ic = document.createElement("div");
    ic.className = "ic";
    ic.innerHTML = CAR_SVG;

    var meta = document.createElement("button");
    meta.className = "meta carrow-select";
    meta.style.cssText = "background:none;border:none;padding:0;text-align:left;cursor:pointer;color:inherit;font:inherit;min-width:0";
    meta.innerHTML = '<p class="nm"></p><p class="mt"></p>';
    meta.querySelector(".nm").textContent = car.name;
    meta.querySelector(".mt").textContent =
      car.battery + " kWh · " + fmtEff(car.eff) + (car.maxkw ? " · " + car.maxkw + " kW" : "");
    meta.addEventListener("click", function () { openEdit(car.id); });

    var right = document.createElement("div");
    right.style.cssText = "flex:none;display:flex;align-items:center;gap:8px";
    if (cars.length > 1) right.appendChild(gripHandle());
    if (car.id === activeId) {
      var tick = document.createElement("span");
      tick.className = "tick";
      tick.textContent = "✓ in use";
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
  $("fEff").value = round1(toDispEff(car.eff));
  $("fEffUnit").textContent = isKm() ? "km/kWh" : "mi/kWh";
  $("fEff").placeholder = isKm() ? "6.1" : "3.8";
  $("fMax").value = car.maxkw || "";
  $("fAcSingle").value = car.acSingle || "";
  $("fAcThree").value = car.acThree || "";
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
  $("fEffUnit").textContent = isKm() ? "km/kWh" : "mi/kWh";
  $("fEff").placeholder = isKm() ? "6.1" : "3.8";
  $("fMax").value = "";
  $("fAcSingle").value = "";
  $("fAcThree").value = "";
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
  var effInput = parseFloat($("fEff").value);
  var maxRaw = $("fMax").value.trim();
  var maxkw = maxRaw === "" ? 0 : parseFloat(maxRaw);
  var acsRaw = $("fAcSingle").value.trim();
  var acSingle = acsRaw === "" ? 0 : parseFloat(acsRaw);
  var actRaw = $("fAcThree").value.trim();
  var acThree = actRaw === "" ? 0 : parseFloat(actRaw);

  if (!name) return showErr("Give the car a name.");
  if (!(battery > 0)) return showErr("Enter the battery size in kWh.");
  if (!(effInput > 0)) return showErr("Enter the efficiency in " + (isKm() ? "km/kWh" : "mi/kWh") + ".");
  var eff = fromDispEff(effInput);
  if (maxRaw !== "" && !(maxkw > 0)) return showErr("Max DC rate must be a positive number, or leave it blank.");
  if (acsRaw !== "" && !(acSingle > 0)) return showErr("Single-phase AC limit must be a positive number, or leave it blank.");
  if (actRaw !== "" && !(acThree > 0)) return showErr("Three-phase AC limit must be a positive number, or leave it blank.");

  var curve = (draftCurve && draftCurve.length === CURVE_SOC.length) ? draftCurve.slice() : DEFAULT_CURVE.slice();
  if (editingId) {
    var car = cars.find(function (c) { return c.id === editingId; });
    car.name = name; car.battery = battery; car.eff = eff; car.maxkw = maxkw; car.curve = curve;
    car.acSingle = acSingle; car.acThree = acThree;
  } else {
    var id = "car-" + Date.now().toString(36);
    cars.push({ id: id, name: name, battery: battery, eff: eff, maxkw: maxkw, curve: curve, acSingle: acSingle, acThree: acThree });
    activeId = id; // newly added car becomes active
    save(ACTIVE_KEY, activeId);
  }
  save(CARS_KEY, cars);
  $("editCard").hidden = true;
  renderHeader();
  renderCarChips();
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
  renderCarChips();
  updateSpeedRange();
  calc();
  renderCarList();
});

/* ---------- chargers manager ---------- */
var editingChargerId = null;
var chgDraftType = "AC";       // AC | DC in the open editor
var chgDraftPhase = "single";  // single | three
var chgTypeManual = false;     // has the user overridden the auto AC/DC choice?

/* Reflect the draft type/phase into the segmented controls, and only show the
   AC-phase picker for AC chargers. */
function renderChgTypeSeg() {
  Array.prototype.forEach.call($("segChgType").children, function (b) {
    b.classList.toggle("on", b.getAttribute("data-v") === chgDraftType);
  });
  Array.prototype.forEach.call($("segChgPhase").children, function (b) {
    b.classList.toggle("on", b.getAttribute("data-v") === chgDraftPhase);
  });
  $("chgPhaseField").hidden = chgDraftType !== "AC";
}

/* Selection chips on the main screen (configuration lives on the Chargers page). */
function renderChargerChips() {
  var wrap = $("chargerChips");
  if (wrap) {
    wrap.innerHTML = "";
    if (!chargers.length) {
      var hint = document.createElement("p");
      hint.className = "chips-empty";
      hint.textContent = "No saved chargers yet — add some from the Chargers button.";
      wrap.appendChild(hint);
    } else {
      chargers.forEach(function (c) {
        var b = document.createElement("button");
        b.className = "chip" + (c.id === activeChargerId ? " active" : "");
        b.textContent = c.name;
        b.addEventListener("click", function () { applyCharger(c); });
        wrap.appendChild(b);
      });
    }
  }
  var cnt = $("mChargerCount");
  if (cnt) cnt.textContent = String(chargers.length);
}

function applyCharger(c) {
  activeChargerId = c.id;
  save(ACTIVE_CHARGER_KEY, activeChargerId);
  $("speed").value = Math.min(c.kw, +$("speed").max);
  $("price").value = Math.max(0, Math.min(c.price, +$("price").max));
  renderChargerChips();
  calc();
}

function renderChargerList() {
  var list = $("chargerList");
  list.innerHTML = "";
  chargers.forEach(function (c, i) {
    var row = document.createElement("div");
    row.className = "carrow" + (c.id === activeChargerId ? " active" : "");
    row.setAttribute("data-id", c.id);

    var ic = document.createElement("div");
    ic.className = "ic";
    ic.innerHTML = BOLT_SVG;

    var meta = document.createElement("button");
    meta.className = "meta";
    meta.style.cssText = "background:none;border:none;padding:0;text-align:left;cursor:pointer;color:inherit;font:inherit;min-width:0";
    meta.innerHTML = '<p class="nm"></p><p class="mt"></p>';
    meta.querySelector(".nm").textContent = c.name;
    meta.querySelector(".mt").textContent = c.kw + " kW · " + typeLabel(c) + " · " + c.price + cur().minor + "/kWh";
    meta.addEventListener("click", function () { openChgEdit(c.id); });

    var right = document.createElement("div");
    right.style.cssText = "flex:none;display:flex;align-items:center;gap:8px";
    if (chargers.length > 1) right.appendChild(gripHandle());
    if (c.id === activeChargerId) {
      var tk = document.createElement("span");
      tk.className = "tick"; tk.textContent = "✓ in use";
      right.appendChild(tk);
    }
    var edit = document.createElement("button");
    edit.className = "editlink"; edit.textContent = "Edit";
    edit.addEventListener("click", function (e) { e.stopPropagation(); openChgEdit(c.id); });
    right.appendChild(edit);

    row.appendChild(ic); row.appendChild(meta); row.appendChild(right);
    list.appendChild(row);
  });
}

function openChgEdit(id) {
  editingChargerId = id;
  var c = chargers.find(function (x) { return x.id === id; });
  $("chgEditTitle").textContent = "Edit charger";
  $("cName").value = c.name;
  $("cSpeed").value = c.kw;
  $("cPrice").value = c.price;
  $("cPriceUnit").textContent = cur().minor + "/kWh";
  chgDraftType = (c.type === "DC") ? "DC" : "AC";
  chgDraftPhase = (c.phase === "three") ? "three" : "single";
  chgTypeManual = true; // an existing charger already has an explicit type
  renderChgTypeSeg();
  $("chgDelete").hidden = false;
  $("chgErr").hidden = true;
  $("chgEditCard").hidden = false;
  $("chgEditCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function openChgAdd() {
  editingChargerId = null;
  $("chgEditTitle").textContent = "Add a charger";
  $("cName").value = ""; $("cSpeed").value = ""; $("cPrice").value = "";
  $("cPriceUnit").textContent = cur().minor + "/kWh";
  chgDraftType = "AC"; chgDraftPhase = "single"; chgTypeManual = false;
  renderChgTypeSeg();
  $("chgDelete").hidden = true;
  $("chgErr").hidden = true;
  $("chgEditCard").hidden = false;
  $("chgEditCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("cName").focus();
}

$("addChargerBtn").addEventListener("click", openChgAdd);
$("chgCancel").addEventListener("click", function () { $("chgEditCard").hidden = true; });

$("segChgType").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-v]"); if (!b) return;
  chgDraftType = b.getAttribute("data-v");
  chgTypeManual = true; // user has taken control of the type
  renderChgTypeSeg();
});
$("segChgPhase").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-v]"); if (!b) return;
  chgDraftPhase = b.getAttribute("data-v");
  renderChgTypeSeg();
});
/* While the user hasn't overridden it, keep the type in step with the power. */
$("cSpeed").addEventListener("input", function () {
  if (chgTypeManual) return;
  var kw = parseFloat(this.value);
  chgDraftType = (kw > 0) ? inferType(kw) : "AC";
  renderChgTypeSeg();
});

function chgShowErr(m) { var e = $("chgErr"); e.textContent = m; e.hidden = false; }

$("chgEditCard").addEventListener("submit", function (e) {
  e.preventDefault();
  var name = $("cName").value.trim();
  var kw = parseFloat($("cSpeed").value);
  var price = parseFloat($("cPrice").value);
  if (!name) return chgShowErr("Give the charger a name.");
  if (!(kw > 0)) return chgShowErr("Enter the charge speed in kW.");
  if (!(price >= 0)) return chgShowErr("Enter the price in p/kWh (0 for free).");

  var phase = chgDraftType === "AC" ? chgDraftPhase : "single";
  if (editingChargerId) {
    var c = chargers.find(function (x) { return x.id === editingChargerId; });
    c.name = name; c.kw = kw; c.price = price; c.type = chgDraftType; c.phase = phase;
  } else {
    chargers.push({ id: "chg-" + Date.now().toString(36), name: name, kw: kw, price: price, type: chgDraftType, phase: phase });
  }
  save(CHARGERS_KEY, chargers);
  $("chgEditCard").hidden = true;
  if (editingChargerId && editingChargerId === activeChargerId) {
    var ac = chargers.find(function (x) { return x.id === activeChargerId; });
    if (ac) {
      $("speed").value = Math.min(ac.kw, +$("speed").max);
      $("price").value = Math.max(0, Math.min(ac.price, +$("price").max));
      calc();
    }
  }
  renderChargerChips();
  renderCompare();
  renderChargerList();
});

$("chgDelete").addEventListener("click", function () {
  if (!editingChargerId) return;
  chargers = chargers.filter(function (x) { return x.id !== editingChargerId; });
  if (activeChargerId === editingChargerId) { activeChargerId = null; save(ACTIVE_CHARGER_KEY, null); }
  save(CHARGERS_KEY, chargers);
  editingChargerId = null;
  $("chgEditCard").hidden = true;
  renderChargerChips();
  renderCompare();
  renderChargerList();
});

/* dragging speed/price by hand deselects the current chip (now "custom") */
["speed", "price"].forEach(function (id) {
  $(id).addEventListener("input", function () {
    if (activeChargerId !== null) { activeChargerId = null; save(ACTIVE_CHARGER_KEY, null); renderChargerChips(); renderCompare(); }
  });
});

wireDragReorder($("carList"), function () { return cars; }, carsChanged);
wireDragReorder($("chargerList"), function () { return chargers; }, chargersChanged);

/* ---------- charging sessions (calibration) ---------- */
function sessErr(m) { var e = $("sessErr"); e.textContent = m; e.hidden = false; }
function fmtFactor(f) { return "×" + (Math.round(f * 100) / 100).toFixed(2); }

function fillSessionSelectors() {
  var carSel = $("sCar"), chgSel = $("sCharger");
  carSel.innerHTML = ""; chgSel.innerHTML = "";
  cars.forEach(function (c) {
    var o = document.createElement("option");
    o.value = c.id; o.textContent = c.name; carSel.appendChild(o);
  });
  chargers.forEach(function (c) {
    var o = document.createElement("option");
    o.value = c.id; o.textContent = c.name + " (" + typeLabel(c) + ")"; chgSel.appendChild(o);
  });
}

function sessTemp() {
  var v = $("sTemp").value.trim();
  if (v === "") return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function sessScenario() {
  var car = cars.find(function (c) { return c.id === $("sCar").value; }) || activeCar();
  var chg = chargers.find(function (c) { return c.id === $("sCharger").value; }) || null;
  return { car: car, chg: chg, from: +$("sFrom").value, to: +$("sTo").value };
}

/* Keep the slider readouts in step and refresh the live estimate. */
function updateSessSliders() {
  $("sFromVal").textContent = (+$("sFrom").value) + "%";
  $("sToVal").textContent = (+$("sTo").value) + "%";
  $("sMinsVal").textContent = fmtTime(+$("sMins").value);
  updateSessEst();
}

/* Live "here's what the app would predict" line under the log form. */
function updateSessEst() {
  var sc = sessScenario();
  $("sCostUnit").textContent = cur().symbol;
  $("sChargerNote").textContent = sc.chg
    ? "This charger is " + typeLabel(sc.chg) + " at " + sc.chg.kw + " kW."
    : "";
  var est = $("sessEst");
  if (!sc.chg || !(sc.to > sc.from)) { est.textContent = ""; return; }
  var chgObj = { id: sc.chg.id, kw: sc.chg.kw, type: sc.chg.type, phase: sc.chg.phase || "single" };
  var mins = estimateMinutes(sc.car, sc.from, sc.to, chgObj, sessTemp());
  var kwh = sc.car.battery * (sc.to - sc.from) / 100;
  var cost = kwh * sc.chg.price / 100 * costCorrection(sc.chg.id);
  est.textContent = "App estimate for this: " + fmtTime(mins) + " · " + money(cost);
}

function openSessionForm() {
  if (!chargers.length) { sessErr("Add a charger first — a session is logged against one."); $("sessEditCard").hidden = false; return; }
  fillSessionSelectors();
  $("sCar").value = activeCar().id;
  var ac = chargers.find(function (x) { return x.id === activeChargerId; }) || chargers[0];
  if (ac) $("sCharger").value = ac.id;
  $("sFrom").value = +$("now").value;
  $("sTo").value = +$("tgt").value;
  $("sMins").value = 35;
  $("sCost").value = ""; $("sKwh").value = ""; $("sTemp").value = "";
  $("sessErr").hidden = true;
  $("sessEditCard").hidden = false;
  updateSessSliders();
  $("sessEditCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function calCell(label, n, f) {
  var val = n > 0 ? fmtFactor(f) : "—";
  var sub = n > 0 ? (n + " session" + (n === 1 ? "" : "s")) : "no data yet";
  return '<div class="cal-cell"><span class="cal-lab">' + escapeHtml(label) + '</span>' +
    '<span class="cal-val">' + val + '</span><span class="cal-sub">' + sub + '</span></div>';
}

/* Compact bar chart of the per-band DC time multipliers, baseline at ×1.00.
   Only bands you've actually charged through (coverage in `cov`) get a bar; the
   rest — where the value would just be the overall fallback — show a faint dot. */
function bandVizSVG(bands, cov) {
  var B = bands.length, W = 320, H = 104, pl = 8, pr = 8, pt = 10, pb = 20;
  var x0 = pl, x1 = W - pr, y0 = H - pb, y1 = pt;
  var covered = bands.map(function (m, i) { return cov && cov[i] >= BAND_COV_MIN; });
  var maxDev = 0.12;
  bands.forEach(function (m, i) { if (covered[i]) maxDev = Math.max(maxDev, Math.abs(m - 1)); });
  var lo = 1 - maxDev * 1.15, hi = 1 + maxDev * 1.15;
  function Y(m) { return y0 - ((m - lo) / (hi - lo)) * (y0 - y1); }
  var base = Y(1), bw = (x1 - x0) / B, out = "";
  out += '<line class="bviz-base" x1="' + x0 + '" y1="' + base.toFixed(1) + '" x2="' + x1 + '" y2="' + base.toFixed(1) + '"/>';
  for (var i = 0; i < B; i++) {
    var cx = x0 + i * bw + bw * 0.5;
    if (!covered[i]) {                        // untouched level: faint marker, no bar
      out += '<circle class="bviz-empty" cx="' + cx.toFixed(1) + '" cy="' + base.toFixed(1) + '" r="1.6"/>';
      continue;
    }
    var m = bands[i], bx = x0 + i * bw + bw * 0.16, wi = bw * 0.68;
    var by = Y(m), top = Math.min(by, base), h = Math.max(1, Math.abs(by - base));
    out += '<rect class="' + (m >= 1 ? "bviz-hi" : "bviz-lo") + '" x="' + bx.toFixed(1) + '" y="' + top.toFixed(1) +
      '" width="' + wi.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"/>';
  }
  [0, 50, 100].forEach(function (p) {
    var lx = x0 + (p / 100) * (x1 - x0);
    out += '<text class="bviz-x" x="' + lx.toFixed(1) + '" y="' + (H - 5) + '">' + p + '%</text>';
  });
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="bviz" role="img" aria-label="DC charge time correction by state of charge, relative to the base estimate. Only charge levels you have logged show a bar; the dashed line is the base estimate; bars above it are slower, below are faster.">' + out + '</svg>';
}

function renderCalSummary() {
  var el = $("calSummary"); if (!el) return;
  var car = activeCar();
  var html = '<p class="cal-h">Time calibration · ' + escapeHtml(car.name) + '</p><div class="cal-grid">';
  html += calCell("DC (rapid)", countSessions(car.id, "DC"), timeCorrection(car.id, "DC"));
  html += calCell("AC", countSessions(car.id, "AC"), timeCorrection(car.id, "AC"));
  html += '</div>';
  var dcN = countSessions(car.id, "DC");
  var bm = dcBandMultipliers(car.id);
  html += '<p class="cal-h">DC time by charge level</p>';
  if (bm.bands) {
    html += bandVizSVG(bm.bands, bm.cov) +
      '<p class="cal-note">A bar per 10% step, but only for levels you’ve actually charged through (a faint dot marks the rest — those just use the overall figure). Above the line = slower than the base estimate at that level, below = faster' +
      (dcN < 3 ? '. With one or two charges the bars stay near the overall figure until more are logged' : '') +
      '.</p>';
  } else {
    html += '<p class="cal-note">' + (dcN > 0
      ? 'Your rapid (DC) charges are counted in the overall figure above; the per-level chart appears once they carry charge-level detail (log a new one on this version).'
      : 'Log a rapid (DC) charge and this fills in — a bar per 10% step showing how it ran versus the estimate.') + '</p>';
  }
  var tempN = sessions.filter(function (s) { return s.carId === car.id && s.type === "DC" && s.temp != null && !isNaN(s.temp); }).length;
  if (tempN >= 2) html += '<p class="cal-note">DC time also flexes with the ambient temperature you set on the calculator — learning from ' + tempN + ' temperature-tagged session' + (tempN === 1 ? '' : 's') + '.</p>';
  var costRows = chargers.map(function (c) {
    return { name: c.name, n: sessions.filter(function (s) { return s.chargerId === c.id; }).length, f: costCorrection(c.id) };
  }).filter(function (r) { return r.n > 0; });
  if (costRows.length) {
    html += '<p class="cal-h">Cost calibration</p><div class="cal-grid">';
    costRows.forEach(function (r) { html += calCell(r.name, r.n, r.f); });
    html += '</div>';
  }
  el.innerHTML = html;
}

function renderSessionList() {
  var list = $("sessionList"); if (!list) return;
  list.innerHTML = "";
  if (!sessions.length) {
    var p = document.createElement("p");
    p.className = "chips-empty";
    p.textContent = "No sessions logged yet — log one after your next charge.";
    list.appendChild(p);
    return;
  }
  sessions.slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); }).forEach(function (s) {
    var car = cars.find(function (c) { return c.id === s.carId; });
    var chg = chargers.find(function (c) { return c.id === s.chargerId; });
    var row = document.createElement("div");
    row.className = "carrow";

    var meta = document.createElement("div");
    meta.className = "meta"; meta.style.minWidth = "0";
    meta.innerHTML = '<p class="nm"></p><p class="mt"></p>';
    var when = new Date(s.date).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    meta.querySelector(".nm").textContent = when + " · " + (car ? car.name : "?") + " · " + (chg ? chg.name : "?") + " · " + s.type;
    var energyBit = "";
    if (s.actualKwh > 0) {
      var perKwh = Math.round(s.actualCost / s.actualKwh * 100);
      energyBit = " · " + round1(s.actualKwh) + " kWh @ " + perKwh + cur().minor + "/kWh";
    }
    meta.querySelector(".mt").textContent =
      s.fromPct + "→" + s.toPct + "% · " + fmtTime(s.actualMins) + " (est " + fmtTime(s.predMins) + ") · " +
      money(s.actualCost) + " (est " + money(s.predCost) + ")" + energyBit + (s.temp != null ? " · " + s.temp + "°C" : "");

    var right = document.createElement("div");
    right.style.cssText = "flex:none";
    var del = document.createElement("button");
    del.className = "editlink danger"; del.textContent = "Delete";
    del.setAttribute("data-del", s.id);
    right.appendChild(del);

    row.appendChild(meta); row.appendChild(right);
    list.appendChild(row);
  });
}

function renderSessions() {
  $("sessEditCard").hidden = true;
  renderCalSummary();
  renderSessionList();
  var mc = $("mSessionCount"); if (mc) mc.textContent = String(sessions.length);
}

$("addSessionBtn").addEventListener("click", openSessionForm);
$("sessCancel").addEventListener("click", function () { $("sessEditCard").hidden = true; });
["sFrom", "sTo", "sMins"].forEach(function (id) {
  $(id).addEventListener("input", updateSessSliders);
});
["sCar", "sCharger"].forEach(function (id) {
  $(id).addEventListener("change", updateSessEst);
});
$("sTemp").addEventListener("input", updateSessEst);

$("sessEditCard").addEventListener("submit", function (e) {
  e.preventDefault();
  var sc = sessScenario();
  if (!sc.chg) return sessErr("Pick a charger.");
  if (!(sc.to > sc.from)) return sessErr("The finish % must be above the start %.");
  var mins = +$("sMins").value;
  var cost = parseFloat($("sCost").value);
  if (!(mins > 0)) return sessErr("Set the actual time.");
  if (!(cost >= 0)) return sessErr("Enter the actual cost.");
  var kwhRaw = $("sKwh").value.trim();
  var actualKwh = kwhRaw === "" ? null : parseFloat(kwhRaw);
  if (actualKwh !== null && !(actualKwh > 0)) return sessErr("Energy must be a positive number, or leave it blank.");
  var temp = sessTemp();

  var chgObj = { id: sc.chg.id, kw: sc.chg.kw, type: sc.chg.type, phase: sc.chg.phase || "single" };
  var predMins = baseMinutes(sc.car, sc.from, sc.to, chgObj);
  var predKwh = sc.car.battery * (sc.to - sc.from) / 100;
  var predCost = predKwh * sc.chg.price / 100;
  // For DC, remember how the predicted time split across SoC bands, so the
  // band-aware calibration can attribute error to the right part of the curve.
  var bands = (sc.chg.type === "DC") ? bandFractions(sc.car, sc.from, sc.to, sc.chg.kw) : null;

  sessions.push({
    id: "sess-" + Date.now().toString(36),
    date: new Date().toISOString(),
    carId: sc.car.id, chargerId: sc.chg.id,
    type: sc.chg.type, phase: sc.chg.phase || "single",
    fromPct: sc.from, toPct: sc.to,
    actualMins: mins, actualCost: cost,
    actualKwh: (actualKwh === null || isNaN(actualKwh)) ? null : actualKwh,
    predMins: predMins, predKwh: predKwh, predCost: predCost,
    chargerKw: sc.chg.kw, bands: bands,
    temp: (temp === null || isNaN(temp)) ? null : temp
  });
  sessions.sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
  if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(sessions.length - MAX_SESSIONS);
  save(SESSIONS_KEY, sessions);

  $("sessEditCard").hidden = true;
  renderSessions();
  calc(); // corrections have changed
});

$("sessionList").addEventListener("click", function (e) {
  var b = e.target.closest("button[data-del]"); if (!b) return;
  var id = b.getAttribute("data-del");
  sessions = sessions.filter(function (s) { return s.id !== id; });
  save(SESSIONS_KEY, sessions);
  renderSessions();
  calc();
});

/* ---------- compare my chargers ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

/* A read-only table of every saved charger's time + cost for the CURRENT
   battery move. Hidden unless there are 2+ chargers. Fastest time and cheapest
   cost are highlighted; the charger in use is tinted. */
function renderCompare() {
  var wrap = $("cmpWrap");
  if (!wrap) return;
  if (chargers.length < 2) { wrap.hidden = true; return; }
  wrap.hidden = false;

  var now = +$("now").value, tgt = +$("tgt").value;
  var car = activeCar();
  var kwh = car.battery * Math.max(0, tgt - now) / 100;

  var ambient = currentAmbient();
  var rows = chargers.map(function (c) {
    var chg = { id: c.id, kw: c.kw, type: c.type, phase: c.phase || "single" };
    return {
      name: c.name,
      mins: estimateMinutes(car, now, tgt, chg, ambient),
      cost: kwh * c.price / 100 * costCorrection(c.id),
      active: c.id === activeChargerId
    };
  });
  var minTime = Math.min.apply(null, rows.map(function (r) { return r.mins; }));
  var minCost = Math.min.apply(null, rows.map(function (r) { return r.cost; }));

  var html = '<div class="cmp-head"><span>for ' + now + '% → ' + tgt + '%</span><span class="r">time</span><span class="r">cost</span></div>';
  html += rows.map(function (r) {
    var fast = (r.mins > 0 && Math.abs(r.mins - minTime) < 0.5) ? " fast" : "";
    var cheap = (kwh > 0 && Math.abs(r.cost - minCost) < 0.005) ? " cheap" : "";
    return '<div class="cmp-row' + (r.active ? " active" : "") + '">' +
      '<span class="nm">' + escapeHtml(r.name) + '</span>' +
      '<span class="v' + fast + '">' + fmtTime(r.mins) + '</span>' +
      '<span class="v' + cheap + '">' + money(r.cost) + '</span></div>';
  }).join("");
  $("cmpPanel").innerHTML = html;
}

$("cmpToggle").addEventListener("click", function () {
  var p = $("cmpPanel");
  p.hidden = !p.hidden;
  this.setAttribute("aria-expanded", String(!p.hidden));
  $("cmpChev").textContent = p.hidden ? "▾" : "▴";
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

/* ---------- service worker + non-intrusive updates ----------
   The worker serves the app from cache (fast, offline) and refreshes in the
   background. A new version installs and waits; we surface a small "Update
   ready" pill and a "Check for updates" menu item, and only reload when the
   user asks — never mid-session. */
var swReg = null;
var swReloading = false;
var swUpdateInitiated = false;   // only reload on controllerchange the user asked for

/* Transient status line (Checking… / You're up to date). */
function swToast(msg) {
  var pill = $("updatePill"); if (!pill) return;
  $("updateMsg").textContent = msg;
  pill.classList.add("toast");            // hides the action buttons
  pill.hidden = false;
  clearTimeout(swToast._t);
  swToast._t = setTimeout(function () { if (pill.classList.contains("toast")) pill.hidden = true; }, 2400);
}

/* Persistent "update ready" prompt with Refresh / dismiss. */
function showUpdatePill() {
  var pill = $("updatePill"); if (!pill) return;
  clearTimeout(swToast._t);
  $("updateMsg").textContent = "Update ready";
  pill.classList.remove("toast");
  pill.hidden = false;
}

function applyUpdate() {
  var w = swReg && swReg.waiting;
  if (w) { swUpdateInitiated = true; w.postMessage({ type: "SKIP_WAITING" }); } // -> activates -> controllerchange -> reload
  else { $("updatePill").hidden = true; }
}

function checkForUpdates() {
  if (!("serviceWorker" in navigator) || !swReg) { swToast("Updates unavailable"); return; }
  swToast("Checking…");
  swReg.update().then(function () {
    setTimeout(function () {
      if (swReg.waiting) showUpdatePill();
      else if (!swReg.installing) swToast("You’re up to date");
      // if installing, the updatefound handler will show the pill when ready
    }, 900);
  }).catch(function () { swToast("Couldn’t check just now"); });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) showUpdatePill();
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", function () {
          // "installed" while a worker already controls the page => it's an update, not first install
          if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdatePill();
        });
      });
    }).catch(function () {});

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      // Only reload for an update the user applied — not the first-install claim.
      if (!swUpdateInitiated || swReloading) return;
      swReloading = true;
      window.location.reload();
    });
  });

  $("updateApply").addEventListener("click", applyUpdate);
  $("updateDismiss").addEventListener("click", function () { $("updatePill").hidden = true; });
}

/* ---------- version + changelog ---------- */
var VERSION = "1.14.2";
var CHANGELOG = [
  { v: "1.14.2", date: "2026-09-25", notes: [
    "Support low-power chargers: charger speed now accepts decimals (e.g. a 1.2 kW granny lead), and the speed slider starts at 1 kW instead of 3 kW"
  ] },
  { v: "1.14.1", date: "2026-09-24", notes: [
    "Fixed the update/status pill not dismissing — “you’re up to date” and the dismiss button now clear it properly"
  ] },
  { v: "1.14.0", date: "2026-09-24", notes: [
    "Loads instantly from its own cache and works properly offline, even on a weak signal (it no longer waits on the network first)",
    "Updates arrive quietly in the background and never interrupt you — a small “Update ready” prompt appears when a new version is waiting, applied only when you tap refresh",
    "Added “Check for updates” to the menu"
  ] },
  { v: "1.13.3", date: "2026-09-23", notes: [
    "The DC charge-level chart now only draws a bar for levels you've actually charged through — untouched levels show a faint dot instead of a misleading bar borrowed from the overall figure"
  ] },
  { v: "1.13.2", date: "2026-09-23", notes: [
    "The session log sliders (start %, finish %, actual time) now ignore accidental thumb-lift nudges, like the main-screen sliders"
  ] },
  { v: "1.13.1", date: "2026-09-23", notes: [
    "The DC charge-level chart now shows a clear placeholder before there's data (it was simply blank), and older logged charges are backfilled so they count toward it"
  ] },
  { v: "1.13.0", date: "2026-09-23", notes: [
    "Rapid (DC) calibration now uses even 10% charge-level bands (was a few uneven bands) — a more uniform, statistically cleaner split; part-covered bands count in proportion",
    "The Sessions page shows a little chart of how much each 10% step runs slower or faster than the base estimate"
  ] },
  { v: "1.12.0", date: "2026-09-23", notes: [
    "Rapid (DC) calibration now reshapes the curve instead of scaling it uniformly — it works out which part of the charge (e.g. above 80%) your car was off on, and only adjusts that part",
    "About page now explains how the app learns from your logged sessions — recency, caution when data is thin, per-band DC time, temperature and real price per kWh"
  ] },
  { v: "1.11.0", date: "2026-09-23", notes: [
    "Log a session with sliders for start %, finish % and actual time",
    "Record the energy delivered (kWh) from your charge receipt — the app learns your real price per kWh, so cost calibration tracks the tariff rather than guessing at energy",
    "Cold weather now factors into rapid (DC) estimates: log the temperature with a few sessions, then set today's temperature on the calculator and the app adjusts"
  ] },
  { v: "1.10.0", date: "2026-09-23", notes: [
    "Chargers now know if they're AC or DC (and single- or three-phase for AC) — set automatically from the power, override anytime",
    "Cars have separate AC charging limits (single- and three-phase) alongside the DC rapid rate, so AC estimates aren't overstated",
    "Smarter estimates: DC follows your curve, AC charges at a flat rate capped by the car's onboard limit",
    "New Sessions page — log a real charge and the app quietly calibrates future time and cost estimates to your car and chargers (recent sessions count most)"
  ] },
  { v: "1.9.0", date: "2026-09-22", notes: [
    "Drag your cars and chargers into any order with the grip handle — the main-screen chips follow the same order"
  ] },
  { v: "1.8.0", date: "2026-09-21", notes: [
    "Back up and restore your data — export your cars, chargers and preferences to a file, and import it back"
  ] },
  { v: "1.7.0", date: "2026-09-21", notes: [
    "New menu (top-right) holds Cars, Chargers, Preferences and About",
    "Choose miles or kilometres and £/€/$ — auto-detected from your browser, changeable in Preferences",
    "Set the top of the price slider in Preferences",
    "Added cost per mile / km to the result"
  ] },
  { v: "1.6.0", date: "2026-09-21", notes: [
    "Compare my chargers: tap to see time and cost for the current top-up across all your saved chargers, with the fastest and cheapest flagged"
  ] },
  { v: "1.5.3", date: "2026-09-21", notes: [
    "Fixed the selected chip's glow being clipped at the edge of the scrolling row"
  ] },
  { v: "1.5.2", date: "2026-09-21", notes: [
    "Car and charger chips scroll sideways instead of wrapping onto multiple rows"
  ] },
  { v: "1.5.1", date: "2026-09-21", notes: [
    "Pick your car and charger from quick chips on the main screen",
    "Manage them from the Cars and Chargers buttons up top; adjust a slider to go back to a custom charger"
  ] },
  { v: "1.5.0", date: "2026-09-21", notes: [
    "Save your favourite chargers (name, speed, price) and apply one in a tap",
    "Managed on their own page, like cars — pick one, then just set your battery levels"
  ] },
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
function aboutKey(e) { if (e.key === "Escape") closeAbout(); }
function openAbout() { drawCurveChart(); $("about").hidden = false; document.addEventListener("keydown", aboutKey); }
function closeAbout() { $("about").hidden = true; document.removeEventListener("keydown", aboutKey); }
$("aboutClose").addEventListener("click", closeAbout);
$("aboutBackdrop").addEventListener("click", closeAbout);

/* ---------- boot ---------- */
renderHeader();
renderCarChips();
renderChargerChips();
renderPrefs();
(function () { var mc = $("mSessionCount"); if (mc) mc.textContent = String(sessions.length); })();
applyPriceMax();
updateSpeedRange();
(function () {
  var ac = chargers.find(function (x) { return x.id === activeChargerId; });
  if (ac) {
    $("speed").value = Math.min(ac.kw, +$("speed").max);
    $("price").value = Math.max(0, Math.min(ac.price, +$("price").max));
  }
})();
calc();
