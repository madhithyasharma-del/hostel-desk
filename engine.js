/* engine.js - the whole Hostel Desk back end, in JavaScript.
 *
 * This is a line-by-line port of core.py. Data lives in the browser (localStorage), so the app
 * needs no server. createEngine(store) works in a browser (store = localStorage) and in Node
 * (store = any object with getItem/setItem), which is how the tests compare it with core.py.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HostelEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CATEGORIES = ["Food", "Snacks", "Travel", "Study", "Health", "Fun", "Bills", "Other"];
  const DEFAULTS = {
    monthly_budget: 5000, water_goal: 8, sleep_goal: 7.5, gym_goal: 3,
    category_budgets: {}, tz_offset_min: 330,
  };
  const KEY = "hostel-desk-data-v1";
  const TABLES = ["expenses", "workouts", "moods"];

  class ValueError extends Error {}

  /* ---------- Python-compatible number formatting ---------- */
  // Python's round() rounds exact ties to even and works on the exact binary value.
  function pyRound(x, n = 0) {
    if (x == null) return null;
    if (!isFinite(x)) return x;
    const neg = x < 0, a = Math.abs(x);
    const str = a.toFixed(Math.min(100, n + 60));
    const dot = str.indexOf(".");
    const intPart = str.slice(0, dot), frac = str.slice(dot + 1);
    const keep = n > 0 ? intPart + "." + frac.slice(0, n) : intPart;
    const rest = frac.slice(n);
    let r;
    if (/^50*$/.test(rest)) {                       // exact tie: pick the even neighbour
      const lastDigit = +keep[keep.length - 1];
      r = lastDigit % 2 === 0 ? Number(keep) : Number((Number(keep) + Math.pow(10, -n)).toFixed(n));
    } else {
      r = Number(a.toFixed(n));
    }
    return neg ? -r : r;
  }
  const _r = (x, n = 1) => (x == null ? null : pyRound(x, n));

  function group(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fmtFixed(x, n, comma) {                  // Python f"{x:.Nf}" and f"{x:,.Nf}"
    const r = pyRound(x, n);
    let s = Math.abs(r).toFixed(n);
    if (comma) { const [i, f] = s.split("."); s = group(i) + (f ? "." + f : ""); }
    return (r < 0 || Object.is(r, -0) && x < 0 ? "-" : "") + s;
  }
  function fmtG(x) {                                // Python f"{x:g}"
    if (x === 0) return "0";
    const e = +x.toExponential(5).split("e")[1];
    if (e < -4 || e >= 6) {
      let [m, ex] = x.toExponential(5).split("e");
      m = m.replace(/\.?0+$/, "");
      const sign = ex[0] === "-" ? "-" : "+";
      return m + "e" + sign + String(Math.abs(+ex)).padStart(2, "0");
    }
    let s = x.toFixed(Math.max(0, 5 - e));
    if (s.includes(".")) s = s.replace(/\.?0+$/, "");
    return s;
  }
  const floatStr = x => (Number.isInteger(x) ? x + ".0" : String(x)); // Python str() of a float
  const plural = (n, one, many) => (n === 1 ? one : many);

  /* ---------- dates as ISO strings ---------- */
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  function isoOf(dt) { return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`; }
  function parts(iso) { return [+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10)]; }
  function toDt(iso) { const [y, m, d] = parts(iso); return new Date(Date.UTC(y, m - 1, d)); }
  function addDays(iso, n) { const dt = toDt(iso); dt.setUTCDate(dt.getUTCDate() + n); return isoOf(dt); }
  function weekday(iso) { return (toDt(iso).getUTCDay() + 6) % 7; }            // Monday = 0
  function daysInMonth(iso) { const [y, m] = parts(iso); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function daysBetween(a, b) { return Math.round((toDt(a) - toDt(b)) / 86400000); } // a - b
  function validIso(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return isoOf(toDt(s)) === s;
  }
  const maxIso = (a, b) => (a > b ? a : b);
  const minIso = (a, b) => (a < b ? a : b);
  // Python 3.12+ adds floats with Neumaier compensated summation, so sum() is a little more exact than a plain loop.
  function sum(xs) {
    let s = 0, c = 0;
    for (const x of xs) {
      const t = s + x;
      if (Math.abs(s) >= Math.abs(x)) c += (s - t) + x; else c += (x - t) + s;
      s = t;
    }
    return Number.isFinite(c) ? s + c : s;
  }
  const mean = xs => sum(xs) / xs.length;
  function pstdev(xs) { const m = mean(xs); return Math.sqrt(sum(xs.map(x => (x - m) * (x - m))) / xs.length); }
  const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  function num(v, lo, hi, name) {
    if (typeof v === "boolean" || v === null || v === undefined) throw new ValueError(`${name} must be a number`);
    if (typeof v === "string") { v = v.trim(); if (v === "") throw new ValueError(`${name} must be a number`); }
    else if (typeof v !== "number") throw new ValueError(`${name} must be a number`);
    if (typeof v === "string") {                     // same strings Python's float() accepts
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) v = Number(v);
      else if (/^[+-]?(inf|infinity)$/i.test(v)) v = v[0] === "-" ? -Infinity : Infinity;
      else if (/^[+-]?nan$/i.test(v)) v = NaN;
      else throw new ValueError(`${name} must be a number`);
    }
    if (Number.isNaN(v) || !(lo <= v && v <= hi)) {
      const nice = x => (x >= 1000 ? fmtFixed(x, 0, true) : fmtG(x));
      throw new ValueError(`${name} must be between ${nice(lo)} and ${nice(hi)}`);
    }
    return v;
  }

  /* ================================================================ engine */
  function createEngine(store, nowMs) {
    nowMs = nowMs || (() => Date.now());
    let db;

    function fresh() { return { settings: {}, expenses: [], health: {}, workouts: [], moods: [], seq: { expenses: 0, workouts: 0, moods: 0 }, meta: {} }; }
    function load() {
      let raw = null;
      try { raw = store.getItem(KEY); } catch (_) {}
      if (!raw) return fresh();
      try {
        const d = JSON.parse(raw);
        const f = fresh();
        for (const k of Object.keys(f)) if (d[k] !== undefined) f[k] = d[k];
        return f;
      } catch (e) {
        try { store.setItem(KEY + ".corrupt", raw); } catch (_) {}   // never overwrite data we can't read
        return fresh();
      }
    }
    function save() { store.setItem(KEY, JSON.stringify(db)); }
    db = load();

    /* ---------- basics ---------- */
    function getSettings() {
      const s = JSON.parse(JSON.stringify(DEFAULTS));
      for (const k of Object.keys(DEFAULTS)) if (db.settings[k] !== undefined) s[k] = db.settings[k];
      return s;
    }
    function updateSettings(patch) {
      const clean = {};
      const has = k => patch[k] !== undefined && patch[k] !== null;
      if (has("monthly_budget")) clean.monthly_budget = _r(num(patch.monthly_budget, 1, 10000000, "monthly budget"), 2);
      if (has("water_goal")) clean.water_goal = Math.trunc(num(patch.water_goal, 1, 30, "water goal"));
      if (has("sleep_goal")) clean.sleep_goal = _r(num(patch.sleep_goal, 3, 12, "sleep goal"), 2);
      if (has("gym_goal")) clean.gym_goal = Math.trunc(num(patch.gym_goal, 1, 7, "gym goal"));
      if (has("tz_offset_min")) clean.tz_offset_min = Math.trunc(num(patch.tz_offset_min, -720, 840, "time zone offset"));
      if (has("category_budgets")) {
        const cb = patch.category_budgets;
        if (typeof cb !== "object" || Array.isArray(cb)) throw new ValueError("category budgets must be an object");
        const out = {};
        for (const [k, v0] of Object.entries(cb)) {
          if (!CATEGORIES.includes(k)) throw new ValueError(`unknown category: ${k}`);
          const v = num(v0, 0, 10000000, `${k} budget`);
          if (v > 0) out[k] = _r(v, 2);
        }
        clean.category_budgets = out;
      }
      Object.assign(db.settings, clean);
      save();
      return getSettings();
    }
    function nowLocalMs() { return nowMs() + getSettings().tz_offset_min * 60000; }
    function todayStr() { return isoOf(new Date(nowLocalMs())); }
    function D(day) {
      if (day === null || day === undefined) return todayStr();
      if (!validIso(String(day))) throw new ValueError("date must look like YYYY-MM-DD");
      return String(day);
    }
    function streak(days, t) {                       // days = Set of ISO strings
      let cur = days.has(t) ? t : addDays(t, -1), n = 0;
      while (days.has(cur)) { n++; cur = addDays(cur, -1); }
      return n;
    }
    function nextId(table) { db.seq[table] = (db.seq[table] || 0) + 1; return db.seq[table]; }
    function del(table, id) {
      const before = db[table].length;
      db[table] = db[table].filter(r => r.id !== id);
      save();
      return db[table].length < before;
    }
    const byDayIdDesc = (a, b) => cmpStr(b.day, a.day) || b.id - a.id;

    /* ---------- expenses ---------- */
    function addExpense(amount, category = "Other", note = "", day = null) {
      amount = _r(num(amount, 0.01, 10000000, "amount"), 2);
      if (!CATEGORIES.includes(category)) throw new ValueError("category must be one of: " + CATEGORIES.join(", "));
      day = D(day);
      note = String(note || "").trim().slice(0, 200);
      const row = { id: nextId("expenses"), day, amount, category, note };
      db.expenses.push(row); save();
      return { ...row };
    }
    function listExpenses(month = null, limit = 300) {
      let rows = db.expenses.slice();
      if (month) rows = rows.filter(r => r.day.startsWith(month));
      return rows.sort(byDayIdDesc).slice(0, limit).map(r => ({ ...r }));
    }
    function expenseSummary(today = null) {
      const t = D(today), s = getSettings(), budget = Number(s.monthly_budget);
      const month = t.slice(0, 7), dim = daysInMonth(t), tday = parts(t)[2];
      const first = t.slice(0, 8) + "01";
      const since = minIso(first, addDays(t, -27));
      const rows = db.expenses.filter(r => r.day >= since).sort((a, b) => cmpStr(a.day, b.day) || a.id - b.id);
      const monthRows = rows.filter(r => r.day.startsWith(month));
      const spent = sum(monthRows.map(r => r.amount));
      const todaySpent = sum(monthRows.filter(r => r.day === t).map(r => r.amount));
      const daysLeft = dim - tday + 1;
      const left = budget - spent;
      const dailyAllowance = Math.max(budget - (spent - todaySpent), 0) / daysLeft;
      const avgDaily = spent / tday, projected = avgDaily * dim, expectedByNow = budget * tday / dim;
      const status = left < 0 ? "over" : spent > expectedByNow * 1.1 ? "fast" : "ok";

      const cb = s.category_budgets, byCat = [];
      for (const c of CATEGORIES) {
        const cSpent = sum(monthRows.filter(r => r.category === c).map(r => r.amount));
        const cBudget = cb[c];
        if (cSpent > 0 || cBudget) {
          byCat.push({ category: c, spent: _r(cSpent, 2), budget: cBudget === undefined ? null : cBudget,
                       pct: cBudget ? _r(cSpent / cBudget * 100) : null });
        }
      }
      byCat.sort((a, b) => -a.spent - -b.spent);

      const totals = {};
      for (const r of rows) totals[r.day] = (totals[r.day] || 0) + r.amount;
      const last14 = [];
      for (let i = 13; i >= 0; i--) { const dd = addDays(t, -i); last14.push({ day: dd, total: _r(totals[dd] || 0, 2) }); }
      const wk = [], we = [];
      for (let i = 0; i < 28; i++) { const dd = addDays(t, -i); (weekday(dd) >= 5 ? we : wk).push(totals[dd] || 0); }
      const weekdayAvg = wk.length ? sum(wk) / wk.length : 0, weekendAvg = we.length ? sum(we) / we.length : 0;
      return {
        month, budget, spent: _r(spent, 2), left: _r(left, 2), today_spent: _r(todaySpent, 2),
        days_left: daysLeft, days_in_month: dim, daily_allowance: _r(dailyAllowance, 2),
        today_left: _r(dailyAllowance - todaySpent, 2), avg_daily: _r(avgDaily, 2), projected: _r(projected, 2),
        expected_by_now: _r(expectedByNow, 2), used_pct: _r(spent / budget * 100), status,
        by_category: byCat, last14, weekday_avg: _r(weekdayAvg, 2), weekend_avg: _r(weekendAvg, 2),
      };
    }

    /* ---------- health ---------- */
    function upsertHealth(day = null, water = null, sleep = null, meals = null, weight = null) {
      day = D(day);
      const vals = {};
      if (water !== null && water !== undefined) vals.water = Math.trunc(num(water, 0, 40, "water"));
      if (sleep !== null && sleep !== undefined) vals.sleep = _r(num(sleep, 0, 24, "sleep"), 2);
      if (meals !== null && meals !== undefined) vals.meals = Math.trunc(num(meals, 0, 10, "meals"));
      if (weight !== null && weight !== undefined) vals.weight = _r(num(weight, 20, 300, "weight"), 1);
      if (!Object.keys(vals).length) throw new ValueError("nothing to save");
      if (!db.health[day]) db.health[day] = { day, water: null, sleep: null, meals: null, weight: null };
      Object.assign(db.health[day], vals); save();
      return { ...db.health[day] };
    }
    const healthRows = since => Object.values(db.health).filter(r => r.day >= since).sort((a, b) => cmpStr(a.day, b.day));

    function healthSummary(today = null) {
      const t = D(today), s = getSettings();
      const rows = {}; for (const r of healthRows(addDays(t, -60))) rows[r.day] = r;
      const last14 = [];
      for (let i = 13; i >= 0; i--) {
        const dd = addDays(t, -i), r = rows[dd] || {};
        last14.push({ day: dd, water: r.water ?? null, sleep: r.sleep ?? null, meals: r.meals ?? null, weight: r.weight ?? null });
      }
      const week = [];
      for (let i = 0; i < 7; i++) { const dd = addDays(t, -i); if (rows[dd]) week.push(rows[dd]); }
      const sleeps = week.filter(r => r.sleep !== null).map(r => r.sleep);
      const waters = week.filter(r => r.water !== null).map(r => r.water);
      const meals = week.filter(r => r.meals !== null).map(r => r.meals);
      const waterDays = new Set(Object.entries(rows).filter(([, r]) => r.water !== null && r.water >= s.water_goal).map(([d]) => d));
      const sleepDays = new Set(Object.entries(rows).filter(([, r]) => r.sleep !== null && r.sleep >= s.sleep_goal - 0.5).map(([d]) => d));
      const weights = Object.entries(rows).sort((a, b) => cmpStr(a[0], b[0]))
        .filter(([d, r]) => r.weight !== null && d >= addDays(t, -30)).map(([d, r]) => [d, r.weight]);
      const weightChange = weights.length >= 2 ? _r(weights[weights.length - 1][1] - weights[0][1]) : null;
      return {
        today: rows[t] ? { ...rows[t] } : { day: t, water: null, sleep: null, meals: null, weight: null },
        last14,
        avg_sleep_7: sleeps.length ? _r(mean(sleeps)) : null,
        avg_water_7: waters.length ? _r(mean(waters)) : null,
        avg_meals_7: meals.length ? _r(mean(meals)) : null,
        sleep_spread: sleeps.length >= 3 ? _r(pstdev(sleeps), 2) : null,
        water_streak: streak(waterDays, t), sleep_streak: streak(sleepDays, t),
        latest_weight: weights.length ? weights[weights.length - 1][1] : null,
        weight_change_30: weightChange, water_goal: s.water_goal, sleep_goal: s.sleep_goal,
      };
    }

    /* ---------- gym ---------- */
    function score1rm(weight, reps) {
      if (weight <= 0) return Number(reps);
      return reps > 1 ? weight * (1 + reps / 30) : Number(weight);
    }
    const pyTitle = s => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    function addWorkout(exercise, sets, reps, weight = 0, note = "", day = null) {
      exercise = pyTitle(String(exercise || "").split(/\s+/).filter(Boolean).join(" ").slice(0, 60));
      if (!exercise) throw new ValueError("exercise name is required");
      sets = Math.trunc(num(sets, 1, 30, "sets"));
      reps = Math.trunc(num(reps, 1, 200, "reps"));
      weight = _r(num(weight, 0, 1000, "weight"), 2);
      day = D(day);
      note = String(note || "").trim().slice(0, 200);
      const prev = db.workouts.filter(r => r.exercise.toLowerCase() === exercise.toLowerCase()).map(r => score1rm(r.weight, r.reps));
      const sc = score1rm(weight, reps);
      const first = prev.length === 0;
      const isPr = prev.length > 0 && sc > Math.max(...prev) + 1e-9;
      const row = { id: nextId("workouts"), day, exercise, sets, reps, weight, note };
      db.workouts.push(row); save();
      return { ...row, is_pr: isPr, first };
    }
    function listWorkouts(limit = 200) { return db.workouts.slice().sort(byDayIdDesc).slice(0, limit).map(r => ({ ...r })); }
    function gymProgress(exercise) {
      const rows = db.workouts.filter(r => r.exercise.toLowerCase() === String(exercise).toLowerCase())
        .sort((a, b) => cmpStr(a.day, b.day) || a.id - b.id);
      const byDay = new Map();
      for (const r of rows) {
        if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, best_weight: 0, best_score: 0 });
        const d = byDay.get(r.day);
        d.best_weight = Math.max(d.best_weight, r.weight);
        d.best_score = Math.max(d.best_score, score1rm(r.weight, r.reps));
      }
      return [...byDay.values()].map(v => ({ ...v, best_score: _r(v.best_score) }));
    }
    const workoutsSorted = () => db.workouts.slice().sort((a, b) => cmpStr(a.day, b.day) || a.id - b.id);

    function gymSummary(today = null) {
      const t = D(today), s = getSettings(), rows = workoutsSorted();
      const ex = new Map();
      for (const r of rows) {
        const k = r.exercise.toLowerCase();
        if (!ex.has(k)) ex.set(k, { exercise: r.exercise, days: new Set(), best_weight: 0, best_score: 0,
                                    last_day: r.day, last_weight: r.weight, last_reps: r.reps });
        const e = ex.get(k);
        e.days.add(r.day);
        e.best_weight = Math.max(e.best_weight, r.weight);
        e.best_score = Math.max(e.best_score, score1rm(r.weight, r.reps));
        e.last_day = r.day; e.last_weight = r.weight; e.last_reps = r.reps;
      }
      const exercises = [...ex.values()].map(e => ({
        exercise: e.exercise, sessions: e.days.size, best_weight: e.best_weight, best_score: _r(e.best_score),
        last_day: e.last_day, last_weight: e.last_weight, last_reps: e.last_reps,
      })).sort((a, b) => cmpStr(b.last_day, a.last_day));

      const thisMonday = addDays(t, -weekday(t)), weekly = [];
      for (let i = 7; i >= 0; i--) {
        const start = addDays(thisMonday, -7 * i), end = addDays(start, 6);
        const inWeek = rows.filter(r => start <= r.day && r.day <= end);
        weekly.push({ week: start, volume: _r(sum(inWeek.map(r => r.sets * r.reps * r.weight)), 0),
                      days: new Set(inWeek.map(r => r.day)).size });
      }
      const allDays = new Set(rows.map(r => r.day));
      const lastDay = rows.length ? [...allDays].reduce(maxIso) : null;
      return {
        exercises, weekly, week_days: weekly[weekly.length - 1].days, week_goal: s.gym_goal,
        days_since_last: lastDay ? daysBetween(t, lastDay) : null,
        day_streak: streak(allDays, t), total_sessions: allDays.size,
      };
    }

    /* ---------- mood ---------- */
    function nowIsoSeconds() { return new Date(nowMs()).toISOString().slice(0, 19) + "+00:00"; }
    function addMood(score, note = "", day = null) {
      score = Math.trunc(num(score, 1, 5, "mood"));
      day = D(day);
      note = String(note || "").trim().slice(0, 200);
      const row = { id: nextId("moods"), day, ts: nowIsoSeconds(), score, note };
      db.moods.push(row); save();
      return { ...row };
    }
    const moodsByTs = () => db.moods.slice().sort((a, b) => cmpStr(b.ts, a.ts) || b.id - a.id);
    function listMoods(limit = 100) { return moodsByTs().slice(0, limit).map(r => ({ ...r })); }
    function moodDaily(since) {
      const d = {};
      for (const r of db.moods) if (r.day >= since) (d[r.day] = d[r.day] || []).push(r.score);
      const out = {}; for (const [k, v] of Object.entries(d)) out[k] = mean(v);
      return out;
    }
    function moodSummary(today = null) {
      const t = D(today), daily = moodDaily(addDays(t, -60));
      const recent = moodsByTs().slice(0, 5).map(r => r.score);
      const todayScores = db.moods.filter(r => r.day === t).map(r => r.score);
      const last14 = [];
      for (let i = 13; i >= 0; i--) { const dd = addDays(t, -i); last14.push({ day: dd, avg: _r(daily[dd] ?? null, 2) }); }
      return {
        last14,
        today_avg: todayScores.length ? _r(mean(todayScores), 2) : null,
        today_count: todayScores.length,
        recent_avg: recent.length ? _r(mean(recent), 2) : null,
        streak: streak(new Set(Object.keys(daily)), t),
      };
    }

    /* ---------- tips + today ---------- */
    function buildTips(t, exp, health, gym, mood) {
      const s = getSettings(), tips = [];
      const add = (kind, icon, text) => tips.push({ kind, icon, text });
      if (exp.status === "over") add("warn", "💸", `You're ₹${fmtFixed(Math.abs(exp.left), 0, true)} over this month's budget. Keep the rest of the month to must-haves.`);
      else if (exp.projected > exp.budget * 1.05 && exp.spent > 0)
        add("warn", "📈", `At this pace you'll spend about ₹${fmtFixed(exp.projected, 0, true)} this month, ` +
          `₹${fmtFixed(exp.projected - exp.budget, 0, true)} over budget. Try keeping to ₹${fmtFixed(exp.daily_allowance, 0, true)} a day.`);
      else if (exp.spent > 0 && exp.today_left !== null && exp.today_left >= 0)
        add("good", "✅", `₹${fmtFixed(exp.today_left, 0, true)} left for today, and you're within your daily allowance.`);
      for (const c of exp.by_category) {
        if (c.pct !== null && c.pct >= 80) {
          add("warn", c.category === "Food" || c.category === "Snacks" ? "🍔" : "🧾", `${c.category} is at ${fmtFixed(c.pct, 0)}% of its budget.`);
          break;
        }
      }
      if (exp.weekday_avg > 0 && exp.weekend_avg > exp.weekday_avg * 1.4)
        add("info", "🎉", `You spend about ₹${fmtFixed(exp.weekend_avg - exp.weekday_avg, 0, true)} more per day on weekends than weekdays.`);

      const last3 = health.last14.slice(-3).filter(r => r.sleep !== null).map(r => r.sleep);
      if (last3.length === 3 && last3.every(x => x < 6)) add("warn", "😴", "Under 6 hours of sleep three days in a row. Go easy at the gym and try an early night.");
      else if (health.avg_sleep_7 !== null && health.avg_sleep_7 < s.sleep_goal - 1)
        add("info", "🌙", `Your 7-day sleep average is ${floatStr(health.avg_sleep_7)}h against a ${floatStr(s.sleep_goal)}h goal.`);
      if (health.sleep_spread !== null && health.sleep_spread > 1.5) add("info", "⏰", "Your sleep hours swing a lot day to day. A steadier schedule usually helps.");

      const w = health.today.water;
      if ((w || 0) < s.water_goal) {
        const left = s.water_goal - (w || 0);
        add("info", "💧", `${left} more glass${left === 1 ? "" : "es"} of water to hit today's goal.`);
      }
      if (gym.total_sessions === 0) add("info", "🏋️", "No workouts logged yet. Log your first one to start tracking progress.");
      else if (gym.days_since_last !== null && gym.days_since_last >= 4) add("warn", "🏋️", `No workout for ${gym.days_since_last} days. Even a short session counts.`);
      else if (gym.week_days >= gym.week_goal) add("good", "🔥", `Weekly gym goal done (${gym.week_days}/${gym.week_goal} days). Nice work.`);

      if (mood.recent_avg !== null && mood.recent_avg <= 2.2)
        add("warn", "🫶", "Your recent moods have been low. A walk, a call home, or talking to a friend can help. If it keeps up, consider speaking to someone you trust.");
      const dm = moodDaily(addDays(t, -30)), low = [], ok = [];
      for (const r of healthRows(addDays(t, -30))) {
        if (r.sleep !== null && dm[r.day] !== undefined) (r.sleep < 6 ? low : ok).push(dm[r.day]);
      }
      if (low.length >= 2 && ok.length >= 3 && mean(ok) - mean(low) >= 0.7)
        add("info", "🔗", "Your mood is noticeably lower on days after you sleep under 6 hours.");
      const order = { warn: 0, info: 1, good: 2 };
      tips.sort((a, b) => order[a.kind] - order[b.kind]);
      return tips.slice(0, 6);
    }
    function todayOverview(today = null) {
      const t = D(today);
      const exp = expenseSummary(t), health = healthSummary(t), gym = gymSummary(t), mood = moodSummary(t);
      return { date: t, settings: getSettings(), expenses: exp, health, gym, mood, tips: buildTips(t, exp, health, gym, mood) };
    }
    function exportAll() {
      const out = { exported_at: nowIsoSeconds(), settings: getSettings() };
      out.expenses = db.expenses.map(r => ({ ...r }));
      out.health = Object.values(db.health).map(r => ({ ...r }));
      out.workouts = db.workouts.map(r => ({ ...r }));
      out.moods = db.moods.map(r => ({ ...r }));
      db.meta.last_backup = todayStr(); save();
      return out;
    }
    function resetAll() { const keepMeta = {}; db = fresh(); db.meta = keepMeta; save(); }

    /* Restore from a backup file made by exportAll() here or by the laptop version. Replaces everything. */
    function importAll(data) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ValueError("That file isn't a Hostel Desk backup.");
      const arr = k => { if (data[k] === undefined) return []; if (!Array.isArray(data[k])) throw new ValueError(`Backup looks damaged: ${k} should be a list.`); return data[k]; };
      const exp = arr("expenses"), hea = arr("health"), wor = arr("workouts"), moo = arr("moods");
      if (!exp.length && !hea.length && !wor.length && !moo.length && !data.settings) throw new ValueError("That file isn't a Hostel Desk backup.");
      const old = db, nu = fresh();
      db = nu;
      try {
        if (data.settings && typeof data.settings === "object") updateSettings(data.settings);
        const seq = { expenses: 0, workouts: 0, moods: 0 }, used = { expenses: new Set(), workouts: new Set(), moods: new Set() };
        const take = (table, id) => { let n = Number.isInteger(id) && id > 0 && !used[table].has(id) ? id : null; if (n === null) { n = 1; while (used[table].has(n)) n++; } used[table].add(n); seq[table] = Math.max(seq[table], n); return n; };
        for (const r of exp) {
          nu.expenses.push({ id: take("expenses", r.id), day: D(r.day), amount: _r(num(r.amount, 0.01, 10000000, "amount"), 2),
                             category: CATEGORIES.includes(r.category) ? r.category : "Other", note: String(r.note || "").trim().slice(0, 200) });
        }
        for (const r of hea) {
          const day = D(r.day), row = { day, water: null, sleep: null, meals: null, weight: null };
          if (r.water != null) row.water = Math.trunc(num(r.water, 0, 40, "water"));
          if (r.sleep != null) row.sleep = _r(num(r.sleep, 0, 24, "sleep"), 2);
          if (r.meals != null) row.meals = Math.trunc(num(r.meals, 0, 10, "meals"));
          if (r.weight != null) row.weight = _r(num(r.weight, 20, 300, "weight"), 1);
          nu.health[day] = row;
        }
        for (const r of wor) {
          const ex = pyTitle(String(r.exercise || "").split(/\s+/).filter(Boolean).join(" ").slice(0, 60));
          if (!ex) throw new ValueError("exercise name is required");
          nu.workouts.push({ id: take("workouts", r.id), day: D(r.day), exercise: ex, sets: Math.trunc(num(r.sets, 1, 30, "sets")),
                             reps: Math.trunc(num(r.reps, 1, 200, "reps")), weight: _r(num(r.weight ?? 0, 0, 1000, "weight"), 2),
                             note: String(r.note || "").trim().slice(0, 200) });
        }
        for (const r of moo) {
          nu.moods.push({ id: take("moods", r.id), day: D(r.day), ts: typeof r.ts === "string" ? r.ts : D(r.day) + "T12:00:00+00:00",
                          score: Math.trunc(num(r.score, 1, 5, "mood")), note: String(r.note || "").trim().slice(0, 200) });
        }
        nu.seq = seq; nu.meta = old.meta || {};
        save();
      } catch (e) {
        db = old; save();                            // nothing changes if the file is bad
        if (e instanceof ValueError) throw new ValueError("Backup couldn't be restored: " + e.message);
        throw e;
      }
      return { ok: true, expenses: exp.length, health: hea.length, workouts: wor.length, moods: moo.length };
    }

    /* ================================================================ 1. type-to-log */
    const NUMWORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const MOOD_WORDS = { terrible: 1, awful: 1, sad: 1, miserable: 1, low: 2, down: 2, tired: 2, stressed: 2, anxious: 2, bad: 2,
      meh: 3, okay: 3, ok: 3, fine: 3, normal: 3, good: 4, happy: 4, calm: 4, great: 5, amazing: 5, awesome: 5, fantastic: 5, excellent: 5 };
    const CATEGORY_WORDS = {
      Food: ["biryani", "lunch", "dinner", "breakfast", "meal", "mess", "canteen", "dosa", "idli", "pizza", "burger", "rice", "curry",
        "thali", "food", "paratha", "parotta", "roti", "noodles", "sandwich", "restaurant", "swiggy", "zomato", "eggs", "fruits"],
      Snacks: ["chai", "tea", "coffee", "samosa", "maggi", "snack", "snacks", "chips", "juice", "biscuit", "biscuits", "chocolate",
        "ice cream", "cold drink", "soda", "puff", "vada", "lassi", "shake"],
      Travel: ["auto", "bus", "metro", "cab", "uber", "ola", "rapido", "train", "petrol", "ticket", "travel", "fare"],
      Study: ["print", "printout", "printouts", "xerox", "stationery", "pen", "notebook", "book", "books", "course", "record", "lab", "exam fee"],
      Health: ["medicine", "medicines", "doctor", "pharmacy", "tablet", "hospital", "protein", "checkup"],
      Fun: ["movie", "game", "games", "party", "outing", "netflix", "cricket", "trip", "concert"],
      Bills: ["recharge", "rent", "fee", "bill", "wifi", "laundry", "mess fee", "electricity", "subscription"],
    };
    const KEYWORDS = [].concat(...Object.entries(CATEGORY_WORDS).map(([c, ws]) => ws.map(w => [w, c])))
      .sort((a, b) => b[0].length - a[0].length);
    const COMMAND_HELP = "Try: spent 120 on biryani, water 3, slept 7 hours, bench press 3x8 40kg, mood 4, weight 65.5, meals 3";
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    function guessCategory(text) {
      for (const cat of CATEGORIES) if (new RegExp(`\\b${cat.toLowerCase()}\\b`).test(text)) return cat;
      for (const [word, cat] of KEYWORDS) if (new RegExp(`\\b${esc(word)}\\b`).test(text)) return cat;
      return "Other";
    }
    function countIn(text) {
      const m = /\d+(?:\.\d+)?/.exec(text);
      if (m) return parseFloat(m[0]);
      for (const w of text.match(/[a-z]+/g) || []) if (Object.prototype.hasOwnProperty.call(NUMWORDS, w)) return NUMWORDS[w];
      return 1;
    }
    function runCommand(text, today = null) {
      const raw = String(text || "").trim();
      if (!raw) throw new ValueError("Type something to log. " + COMMAND_HELP);
      let t = raw.toLowerCase().replace(/₹/g, " ");
      t = t.replace(/\b(?:rs|inr)\b\.?/g, " ");
      let day = D(today), when = "";
      if (/\byesterday\b/.test(t)) { day = addDays(D(today), -1); when = " (yesterday)"; }
      t = t.replace(/\b(?:yesterday|today)\b/g, " ").replace(/\s+/g, " ").trim();

      let m = /^(?:(?:did|log|logged|workout|gym|trained|had)\s+)*(?<ex>[a-z][a-z\- ]*?)\s+(?<sets>\d{1,2})\s*(?:x|×|sets?\s+(?:of|x))\s*(?<reps>\d{1,3})(?:\s*(?:@|at|with|of)?\s*(?<w>\d+(?:\.\d+)?)\s*(?:kgs?|kilos?)?)?$/.exec(t);
      if (m) {
        const g = m.groups;
        const r = addWorkout(g.ex, parseInt(g.sets, 10), parseInt(g.reps, 10), g.w ? parseFloat(g.w) : 0, "", day);
        const w = r.weight ? ` at ${fmtG(r.weight)} kg` : ", bodyweight";
        const extra = r.is_pr ? " New personal best!" : r.first ? " First time logged, this is your baseline." : "";
        return { kind: "workout", is_pr: r.is_pr, summary: `Logged ${r.exercise} ${r.sets}×${r.reps}${w}${when}.${extra}` };
      }
      m = /^(?:mood|feeling|felt|i am|i'm|im|i feel)\s*(?:is|was|like)?\s*(.*)$/.exec(t);
      if (m) {
        const rest = m[1]; let score = null, note = "";
        const mm = /^([1-5])\b\s*(.*)$/.exec(rest);
        if (mm) { score = parseInt(mm[1], 10); note = mm[2]; }
        else {
          const i = rest.indexOf(" "), first = i < 0 ? rest : rest.slice(0, i), tail = i < 0 ? "" : rest.slice(i + 1);
          if (Object.prototype.hasOwnProperty.call(MOOD_WORDS, first)) { score = MOOD_WORDS[first]; note = tail; }
        }
        if (score === null) throw new ValueError("For mood, give a number from 1 to 5 or a word like good, low or great. Example: mood 4");
        addMood(score, note, day);
        return { kind: "mood", is_pr: false, summary: `Mood saved: ${score}/5${when}.` };
      }
      m = /\b(?:slept|sleep)\b\D*?(\d+(?:\.\d+)?)/.exec(t);
      if (m) { upsertHealth(day, null, parseFloat(m[1])); return { kind: "sleep", is_pr: false, summary: `Sleep saved: ${fmtG(parseFloat(m[1]))} h${when}.` }; }
      m = /\b(?:weight|weigh|weighed|wt)\b\D*?(\d+(?:\.\d+)?)/.exec(t);
      if (m) { upsertHealth(day, null, null, null, parseFloat(m[1])); return { kind: "weight", is_pr: false, summary: `Weight saved: ${fmtG(parseFloat(m[1]))} kg${when}.` }; }
      if (/\b(?:water|glass|glasses)\b/.test(t)) {
        const row = db.health[day], cur = row && row.water !== null ? row.water : 0;
        const n = Math.trunc(countIn(t));
        const total = /^water\s*(?:=|to|total)?\s*\d+$/.test(t) ? n : cur + n;
        upsertHealth(day, total);
        return { kind: "water", is_pr: false, summary: `Water: ${total} glass${total === 1 ? "" : "es"}${when}.` };
      }
      m = /\bate\s+(\d+)\s+meals?\b/.exec(t) || /^meals?\s+(\d+)$/.exec(t);
      if (m && parseInt(m[1], 10) <= 10) { upsertHealth(day, null, null, parseInt(m[1], 10)); return { kind: "meals", is_pr: false, summary: `Meals saved: ${parseInt(m[1], 10)}${when}.` }; }

      const found = [...t.matchAll(/\d+(?:\.\d+)?/g)];
      if (found.length) {
        const mv = /\b(?:spent|paid|pay|spend|bought)\s+(\d+(?:\.\d+)?)/.exec(t);
        let pick;
        if (mv) { const at = mv.index + mv[0].length - mv[1].length; pick = found.find(f => f.index === at); }
        else { pick = found[0]; for (const f of found) if (parseFloat(f[0]) > parseFloat(pick[0])) pick = f; }  // first max, like Python
        const amount = parseFloat(pick[0]);
        const rest = t.slice(0, pick.index) + " " + t.slice(pick.index + pick[0].length);
        const words = rest.replace(/\b(?:spent|spend|paid|pay|bought|buy|for|on|of|at|in|the|rupees|rupee|expense)\b/g, " ");
        const category = guessCategory(t);
        let note = category !== "Other" ? words.replace(new RegExp(`\\b${category.toLowerCase()}\\b`, "g"), " ") : words;
        note = note.replace(/\s+/g, " ").trim();
        const r = addExpense(amount, category, note ? note[0].toUpperCase() + note.slice(1).toLowerCase() : "", day);
        const what = r.note ? ` (${r.note})` : "";
        return { kind: "expense", is_pr: false, summary: `Logged ₹${fmtG(r.amount)} for ${category}${what}${when}.` };
      }
      throw new ValueError(`I couldn't tell what to log from "${raw}". ` + COMMAND_HELP);
    }

    /* ================================================================ 2. life score */
    const LEVEL_NAMES = ["Fresher", "Settled in", "Regular", "Senior", "Block captain", "Hostel legend"];
    const SCORE_MAX = { money: 25, sleep: 25, water: 15, gym: 20, mood: 15 };

    function scoreDay(d, s = null) {
      s = s || getSettings();
      const active = db.expenses.some(r => r.day === d) || !!db.health[d] || db.workouts.some(r => r.day === d) || db.moods.some(r => r.day === d);
      if (!active) return null;
      const h = db.health[d] || null;
      const mood = db.moods.some(r => r.day === d);
      const lo = addDays(d, -6);
      const gymDays = new Set(db.workouts.filter(r => r.day >= lo && r.day <= d).map(r => r.day)).size;
      const e = expenseSummary(d), allowance = e.daily_allowance, spent = e.today_spent;
      let money;
      if (allowance <= 0) money = spent > 0 ? 0 : SCORE_MAX.money;
      else money = SCORE_MAX.money * Math.max(0, 1 - Math.max(0, spent - allowance) / allowance);
      const sleep = h ? SCORE_MAX.sleep * Math.min((h.sleep || 0) / s.sleep_goal, 1) : 0;
      const water = h ? SCORE_MAX.water * Math.min((h.water || 0) / s.water_goal, 1) : 0;
      const gym = SCORE_MAX.gym * Math.min(gymDays / s.gym_goal, 1);
      const moodp = mood ? SCORE_MAX.mood : 0;
      const ps = [
        ["money", "Spending", money, "within today's allowance"],
        ["sleep", "Sleep", sleep, `${fmtG(s.sleep_goal)} h goal`],
        ["water", "Water", water, `${s.water_goal} glasses`],
        ["gym", "Gym", gym, `${gymDays} day${gymDays === 1 ? "" : "s"} this week, goal ${s.gym_goal}`],
        ["mood", "Mood check-in", moodp, "log how you feel"],
      ];
      return { day: d, total: pyRound(sum(ps.map(p => p[2])), 0),
               parts: ps.map(([key, label, p, hint]) => ({ key, label, points: _r(p, 1), max: SCORE_MAX[key], hint })) };
    }
    function levelOf(xp) { let l = 1; while (xp >= 75 * (l + 1) * l) l++; return l; }
    function countPrs() {
      const best = {}; let n = 0;
      for (const r of workoutsSorted()) {
        const k = r.exercise.toLowerCase(), sc = score1rm(r.weight, r.reps);
        if (k in best && sc > best[k] + 1e-9) n++;
        best[k] = Math.max(best[k] ?? 0, sc);
      }
      return n;
    }
    function scoreOverview(today = null) {
      const t = D(today), s = getSettings();
      const firsts = [...db.expenses.map(r => r.day), ...Object.keys(db.health), ...db.workouts.map(r => r.day), ...db.moods.map(r => r.day)];
      const first = firsts.length ? firsts.reduce(minIso) : null;
      let xp = 0, active = 0, todayScore = null; const history = [];
      if (first) {
        let d = maxIso(first, addDays(t, -730));
        const cut = addDays(t, -14);
        while (d <= t) {
          const sc = scoreDay(d, s);
          if (sc) { xp += sc.total; active++; }
          if (d === t) todayScore = sc;
          if (d > cut) history.push({ day: d, score: sc ? sc.total : null });
          d = addDays(d, 1);
        }
      }
      for (let i = 0; i < 14; i++) { const iso = addDays(t, -(13 - i)); if (!history.some(h => h.day === iso)) history.push({ day: iso, score: null }); }
      history.sort((a, b) => cmpStr(a.day, b.day));
      const lvl = levelOf(xp), base = 75 * lvl * (lvl - 1);
      const hs = healthSummary(t), gs = gymSummary(t), ms = moodSummary(t), es = expenseSummary(t), prs = countPrs();
      const bestWeek = Math.max(0, ...gs.weekly.map(w => w.days));
      const tday = parts(t)[2];
      const paceOk = es.status === "ok" && es.spent > 0 && tday >= 7;
      const badge = (id, icon, name, desc, unlocked, progress) => ({ id, icon, name, desc, unlocked: !!unlocked, progress });
      const badges = [
        badge("regular", "📅", "Regular", "Log something on 7 different days", active >= 7, `${Math.min(active, 7)}/7 days`),
        badge("dedicated", "🏅", "Dedicated", "Log something on 30 different days", active >= 30, `${Math.min(active, 30)}/30 days`),
        badge("hydrated", "💧", "Hydrated", "Hit your water goal 3 days in a row", hs.water_streak >= 3, `${Math.min(hs.water_streak, 3)}/3 days`),
        badge("rested", "😴", "Well rested", "Sleep near your goal 3 days in a row", hs.sleep_streak >= 3, `${Math.min(hs.sleep_streak, 3)}/3 days`),
        badge("iron", "🏋️", "Iron week", "Hit your weekly gym goal", bestWeek >= s.gym_goal, `best week ${bestWeek}/${s.gym_goal} days`),
        badge("pb", "🎯", "Personal best", "Beat your own record on any lift", prs >= 1, `${prs} so far`),
        badge("pace", "💰", "Pace keeper", "Be on budget pace a week into the month", paceOk,
          paceOk ? "on pace" : (tday < 7 ? "day " + Math.min(tday, 7) + " of 7" : "spend less than an even pace")),
        badge("checkin", "🙂", "Check-in streak", "Log your mood 5 days in a row", ms.streak >= 5, `${Math.min(ms.streak, 5)}/5 days`),
      ];
      return { date: t, today: todayScore, active_days: active, xp, level: lvl,
               level_name: LEVEL_NAMES[Math.min(lvl - 1, LEVEL_NAMES.length - 1)],
               xp_into: xp - base, xp_span: 150 * lvl, history, badges };
    }

    /* ================================================================ 3. insights lab */
    const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    function insightsOverview(today = null) {
      const t = D(today), s = getSettings(), since = addDays(t, -60), days = {};
      const row = day => (days[day] = days[day] || { sleep: null, moods: [], gym: false, eat: 0 });
      const byDay = (a, b) => cmpStr(a.day, b.day) || (a.id || 0) - (b.id || 0);   // same order SQLite reads its day index
      for (const r of Object.values(db.health).sort(byDay)) if (r.day >= since) row(r.day).sleep = r.sleep;
      for (const r of db.moods.slice().sort(byDay)) if (r.day >= since) row(r.day).moods.push(r.score);
      for (const r of db.workouts.slice().sort(byDay)) if (r.day >= since) row(r.day).gym = true;
      for (const r of db.expenses.slice().sort(byDay)) if (r.day >= since && (r.category === "Food" || r.category === "Snacks")) row(r.day).eat += r.amount;
      for (const x of Object.values(days)) x.mood = x.moods.length ? mean(x.moods) : null;
      const insights = [], needs = [];
      const moodDays = Object.fromEntries(Object.entries(days).filter(([, x]) => x.mood !== null));
      const label = n => (n < 14 ? "early signal" : "pattern");

      const both = Object.values(moodDays).filter(x => x.sleep !== null);
      if (both.length < 7) needs.push(`Log sleep and mood on 7 days to unlock sleep insights (${both.length}/7 so far).`);
      else {
        const enough = both.filter(x => x.sleep >= s.sleep_goal - 0.5).map(x => x.mood);
        const short = both.filter(x => x.sleep < s.sleep_goal - 0.5).map(x => x.mood);
        if (enough.length >= 3 && short.length >= 3 && Math.abs(mean(enough) - mean(short)) >= 0.4) {
          const hi = mean(enough) > mean(short);
          insights.push({ id: "sleep_mood", icon: "😴", strength: label(both.length), n: both.length,
            title: hi ? "Sleep and mood move together" : "Your mood doesn't follow your sleep",
            detail: `On days you slept near your ${fmtG(s.sleep_goal)} h goal your mood averaged ${fmtFixed(mean(enough), 1)}/5, against ${fmtFixed(mean(short), 1)}/5 after shorter nights.` +
              (hi ? " Protecting your sleep looks like the easiest mood boost." : " Something else is driving your mood.") });
        }
      }
      const gymM = Object.values(moodDays).filter(x => x.gym).map(x => x.mood);
      const restM = Object.values(moodDays).filter(x => !x.gym).map(x => x.mood);
      if (gymM.length < 3 || restM.length < 3)
        needs.push(`Log mood on 3 gym days and 3 rest days to compare them (${Math.min(gymM.length, 3)}/3 and ${Math.min(restM.length, 3)}/3 so far).`);
      else if (Math.abs(mean(gymM) - mean(restM)) >= 0.4) {
        const hi = mean(gymM) > mean(restM);
        insights.push({ id: "gym_mood", icon: "🏋️", strength: label(gymM.length + restM.length), n: gymM.length + restM.length,
          title: hi ? "You feel better on gym days" : "Gym days are your lower-mood days",
          detail: `Mood averaged ${fmtFixed(mean(gymM), 1)}/5 on workout days and ${fmtFixed(mean(restM), 1)}/5 on rest days.` +
            (hi ? "" : " That can mean you train when you're stressed, or that sessions leave you drained.") });
      }
      const low = Object.values(moodDays).filter(x => x.mood <= 2).map(x => x.eat);
      const high = Object.values(moodDays).filter(x => x.mood >= 4).map(x => x.eat);
      if (low.length >= 2 && high.length >= 3 && mean(low) >= mean(high) * 1.3 && mean(low) - mean(high) >= 30)
        insights.push({ id: "stress_eating", icon: "🍔", strength: label(low.length + high.length), n: low.length + high.length,
          title: "Low days cost more in food and snacks",
          detail: `On days your mood was 2 or lower you spent about ₹${fmtFixed(mean(low), 0, true)} on food and snacks, against ₹${fmtFixed(mean(high), 0, true)} on days it was 4 or higher.` });

      const byWd = new Map();                          // a Map keeps insertion order, which breaks ties like Python
      for (const [d, x] of Object.entries(moodDays)) { const w = weekday(d); if (!byWd.has(w)) byWd.set(w, []); byWd.get(w).push(x.mood); }
      const ok = new Map(); for (const [w, v] of byWd) if (v.length >= 2) ok.set(w, mean(v));
      if (ok.size >= 3) {
        let best = null, worst = null;
        for (const [k, v] of ok) { if (best === null || v > ok.get(best)) best = k; if (worst === null || v < ok.get(worst)) worst = k; }
        if (ok.get(best) - ok.get(worst) >= 0.8) {
          const n = sum([...byWd.values()].map(v => v.length));
          insights.push({ id: "weekday_mood", icon: "📆", strength: label(n), n,
            title: `${WEEKDAYS[best]} is your best day, ${WEEKDAYS[worst]} your toughest`,
            detail: `Mood averages ${fmtFixed(ok.get(best), 1)}/5 on ${WEEKDAYS[best]}s and ${fmtFixed(ok.get(worst), 1)}/5 on ${WEEKDAYS[worst]}s. Plan something to look forward to on ${WEEKDAYS[worst]}s.` });
        }
      }
      if (!insights.length && !needs.length) needs.push("No strong patterns yet. Keep logging and check back.");
      return { insights, needs: needs.slice(0, 3), days_considered: Object.keys(days).length,
               note: "These are patterns in your own numbers, not proof of cause." };
    }

    /* ================================================================ routes (same URLs as main.py) */
    function route(method, url, body) {
      const [path, qs] = url.split("?"), q = new URLSearchParams(qs || ""), b = body || {};
      let m;
      if (method === "GET" && path === "/api/today") return todayOverview();
      if (method === "GET" && path === "/api/meta") return { categories: CATEGORIES, today: todayStr() };
      if (path === "/api/settings") return method === "PUT" ? updateSettings(b) : getSettings();
      if (path === "/api/expenses" && method === "POST") return addExpense(b.amount, b.category ?? "Other", b.note ?? "", b.day ?? null);
      if (path === "/api/expenses" && method === "GET") return listExpenses(q.get("month"));
      if (path === "/api/expenses/summary") return expenseSummary();
      if (path === "/api/health" && method === "PUT") return upsertHealth(b.day ?? null, b.water ?? null, b.sleep ?? null, b.meals ?? null, b.weight ?? null);
      if (path === "/api/health/summary") return healthSummary();
      if (path === "/api/workouts" && method === "POST") return addWorkout(b.exercise, b.sets, b.reps, b.weight ?? 0, b.note ?? "", b.day ?? null);
      if (path === "/api/workouts" && method === "GET") return listWorkouts();
      if (path === "/api/workouts/summary") return gymSummary();
      if (path === "/api/workouts/progress") return gymProgress(q.get("exercise") || "");
      if (path === "/api/moods" && method === "POST") return addMood(b.score, b.note ?? "", b.day ?? null);
      if (path === "/api/moods" && method === "GET") return listMoods();
      if (path === "/api/command" && method === "POST") return runCommand(b.text);
      if (path === "/api/score") return scoreOverview();
      if (path === "/api/insights") return insightsOverview();
      if (path === "/api/export") return exportAll();
      if (path === "/api/import" && method === "POST") return importAll(b);
      if (path === "/api/reset-all" && method === "DELETE") { resetAll(); return { ok: true }; }
      if (method === "DELETE" && (m = /^\/api\/(expenses|workouts|moods)\/(\d+)$/.exec(path))) {
        if (!del(m[1], parseInt(m[2], 10))) { const e = new Error("not found"); e.status = 404; throw e; }
        return { ok: true };
      }
      const e = new Error("Not Found"); e.status = 404; throw e;
    }
    function handle(method, url, body) {
      try { return { status: 200, data: route(method, url, body) }; }
      catch (e) {
        if (e instanceof ValueError) return { status: 400, data: { detail: e.message } };
        if (e && e.status) return { status: e.status, data: { detail: e.message } };
        return { status: 500, data: { detail: "Something went wrong. Try again." } };
      }
    }

    return {
      handle, entryCount: () => db.expenses.length + Object.keys(db.health).length + db.workouts.length + db.moods.length, backupAge: () => db.meta.last_backup || null, hasData: () => db.expenses.length + Object.keys(db.health).length + db.workouts.length + db.moods.length > 0,
      core: { getSettings, updateSettings, addExpense, listExpenses, expenseSummary, upsertHealth, healthSummary, addWorkout, listWorkouts,
              gymProgress, gymSummary, addMood, listMoods, moodSummary, todayOverview, exportAll, importAll, resetAll, runCommand,
              scoreOverview, insightsOverview, todayStr },
    };
  }

  /* Pull the amount (and the UPI id, if the bank prints one) out of a bank debit SMS. */
  function parseBankSms(text) {
    const s = String(text || "");
    const am = /(?:rs\.?|inr|₹)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i.exec(s);
    if (!am) return null;
    const amount = parseFloat(am[1].replace(/,/g, ""));
    if (!(amount > 0 && amount <= 10000000)) return null;
    const incoming = /\b(credited|received|deposited)\b/i.test(s) && !/\b(debited|debit|sent|paid|spent|withdrawn)\b/i.test(s);
    const pm = /\bto\s+(?:vpa\s+)?([A-Za-z0-9._-]{2,40}@[A-Za-z0-9.-]{2,20})/i.exec(s);
    return { amount, payee: pm ? pm[1] : null, incoming };
  }

  /* The greeting and "today's focus" at the top of the Today screen, built from the /api/today data. */
  function indianGrouping(n) {
    const s = String(Math.round(Math.abs(n)));
    return s.length > 3 ? s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + s.slice(-3) : s;
  }
  function greeting(t, hour) {
    const title = hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 17 ? "Good afternoon" : hour >= 17 && hour < 22 ? "Good evening" : "Late night";
    const e = t.expenses, h = t.health, g = t.gym, inr = n => "₹" + indianGrouping(n);
    const parts = [];
    if (e.left <= 0) parts.push("pocket money used up");
    else if (e.today_left < 0) parts.push(`over today's allowance by ${inr(e.today_left)}`);
    else parts.push(`${inr(e.today_left)} left today`);
    const w = h.today.water || 0;
    if (w < h.water_goal) { const n = h.water_goal - w; parts.push(`${n} glass${n === 1 ? "" : "es"} of water to go`); }
    if (g.total_sessions === 0) parts.push("no workouts logged yet");
    else if (g.week_days >= g.week_goal) parts.push("weekly gym goal done");
    else { const n = g.week_goal - g.week_days; parts.push(`${n} more workout${n === 1 ? "" : "s"} this week`); }
    if (t.mood.today_count === 0) parts.push("mood not logged yet");
    const line = parts.slice(0, 3).join(", ");
    const focus = t.tips.length ? t.tips[0] : { kind: "info", icon: "✨", text: "Nothing to flag. Log today's spending, water and sleep to get tips." };
    return { title, line: line[0].toUpperCase() + line.slice(1) + ".", focus };
  }

  return { createEngine, ValueError, parseBankSms, greeting, util: { pyRound, fmtFixed, fmtG } };
});
