// ---------- Theme ----------
// The theme is picked before first paint by the small inline script in index.html's <head>
// (saved choice, else the device's light/dark setting); toggling saves the choice.
const THEME_KEY = 'malist-theme';
function applySavedTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  const theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  try { localStorage.setItem(THEME_KEY, next); } catch {}
}
// Follow the device setting live, unless the person has picked a theme themselves.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch {}
  if (!saved) applySavedTheme();
});

// ---------- State ----------
let currentZone = 'all';
let currentCategory = 'all';
let currentEventTab = 'today';
let searchQuery = '';
const YOU = 'You';

const zoneShort = { male: 'Malé', phase1: 'Phase 1', phase2: 'Phase 2' };

// ---------- Date model ----------
// Events store real dates (startDate/endDate, ISO YYYY-MM-DD) instead of a
// hand-picked dateTab label + free-text date string. Today/Weekend/Upcoming/Past
// are all *computed* from these on every render, so an event correctly moves
// between buckets as real time passes, and nothing needs to be manually re-tagged
// or ever goes stale the way a typed "dateTab: 'today'" would.
function dateOnly(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function todayDateOnly() { return dateOnly(new Date()); }
function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function parseISODate(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
// Maldives weekend = Friday & Saturday. Returns the *upcoming* (or current) Fri/Sat pair.
function weekendRange(now) {
  const day = now.getDay(); // 0 Sun .. 6 Sat
  let offsetToFri;
  if (day === 5) offsetToFri = 0;
  else if (day === 6) offsetToFri = -1;
  else offsetToFri = (5 - day + 7) % 7;
  const fri = dateOnly(now); fri.setDate(fri.getDate() + offsetToFri);
  const sat = dateOnly(fri); sat.setDate(sat.getDate() + 1);
  return { fri, sat };
}
// The single source of truth for which tab an event belongs in right now.
function computeEventTab(e, now) {
  const start = parseISODate(e.startDate);
  if (!start) return 'upcoming'; // safety fallback for malformed data
  const end = parseISODate(e.endDate) || start;
  const today = todayDateOnly();
  if (end < today) return 'past';
  if (start <= today && today <= end) return 'today';
  const { fri, sat } = weekendRange(now);
  if (start <= sat && end >= fri) return 'weekend';
  return 'upcoming';
}
// Human-readable date label, derived from startDate/endDate — never stored.
function formatEventDate(e) {
  const start = parseISODate(e.startDate);
  if (!start) return '';
  const end = parseISODate(e.endDate);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const year = start.getFullYear();
  if (!end || end.getTime() === start.getTime()) return `${fmt(start)}, ${year}`;
  if (start.getMonth() === end.getMonth()) return `${fmt(start)}–${end.getDate()}, ${year}`;
  return `${fmt(start)} – ${fmt(end)}, ${year}`;
}
const eventTabLabel = { today: 'Today', weekend: 'This weekend', upcoming: 'Upcoming', past: 'Past' };

let shopsData = [], eventsData = [], commoditiesData = [], leaderboard = {}, advisories = [];

// ---------- Data: community data file in the GitHub repo ----------
// Approved community submissions live in data/data.json in this repo. The site only
// READS that file; nothing on this page can write to the repo (so no token ever ships
// in the page). New submissions go through a pre-filled GitHub issue, and the repo owner
// approves them with "/approve" — a GitHub Action validates them and updates the file.
const REPO = 'Ameenex/MaList';
const POINTS = { shops: 10, events: 10, commodities: 15 };

// Everything that comes from the data file is treated as untrusted text and escaped
// before it is placed into HTML.
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Defence in depth: even though the approval Action already validates everything, the site
// re-checks each entry and skips anything malformed rather than trusting the file blindly.
const ZONE_KEYS = ['male', 'phase1', 'phase2'];
const CAT_KEYS = ['fihaara', 'clinic', 'services'];
const okId = x => typeof x.id === 'string' && /^[a-z]{2}-\d{1,9}$/.test(x.id);
const okStr = v => typeof v === 'string' && v.length > 0 && v.length <= 600;
const VALID = {
  shops: x => okId(x) && okStr(x.name) && okStr(x.address) && ZONE_KEYS.includes(x.zone) && CAT_KEYS.includes(x.category),
  events: x => okId(x) && okStr(x.title) && okStr(x.location) && okStr(x.time) && ZONE_KEYS.includes(x.zone) && /^\d{4}-\d{2}-\d{2}$/.test(x.startDate || '') && (!x.endDate || /^\d{4}-\d{2}-\d{2}$/.test(x.endDate)),
  commodities: x => okId(x) && okStr(x.name) && okStr(x.shop) && ZONE_KEYS.includes(x.zone) && typeof x.price === 'number' && isFinite(x.price) && x.price > 0
};
function asList(v, kind) { return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && VALID[kind](x)) : []; }

async function fetchCommunityData() {
  try {
    const res = await fetch('./data/data.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return { shops: asList(j.shops, 'shops'), events: asList(j.events, 'events'), commodities: asList(j.commodities, 'commodities') };
  } catch (e) {
    console.warn('Community data file unavailable, showing built-in sample data only:', e);
    return { shops: [], events: [], commodities: [] };
  }
}

// Built-in content (data/builtin.json): real official events, plus made-up sample entries that
// only fill a list while the community has none of that kind yet. Samples carry isSample so
// the UI can label them "Example" instead of passing them off as real listings.
async function fetchJSON(path, fallback) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } catch (e) {
    console.warn(`${path} unavailable:`, e);
    return fallback;
  }
}

function resolveSampleEvent(e) {
  const today = todayDateOnly();
  const map = { today: isoDate(today), weekend: isoDate(weekendRange(today).sat) };
  return { ...e, startDate: map[e.startDate] || e.startDate, isSample: true };
}

async function loadData() {
  const [c, builtin, adv] = await Promise.all([
    fetchCommunityData(),
    fetchJSON('./data/builtin.json', { events: [], samples: {} }),
    fetchJSON('./data/advisories.json', { advisories: [] })
  ]);
  const smp = builtin.samples || {};
  const mark = list => (list || []).map(x => ({ ...x, isSample: true }));
  const real = list => list.slice().reverse(); // newest community entries first

  shopsData = c.shops.length ? real(c.shops) : mark(smp.shops);
  commoditiesData = c.commodities.length ? real(c.commodities)
    : mark(smp.commodities).map(x => ({ ...x, ts: Date.now() - (x.daysAgo || 0) * 86400000 }));
  const officialEvents = builtin.events || [];
  eventsData = c.events.length ? [...real(c.events), ...officialEvents]
    : [...(smp.events || []).map(resolveSampleEvent), ...officialEvents];
  issuesData = mark(smp.issues);
  advisories = (adv.advisories || []).filter(a => okStr(a.title) && okStr(a.text) && (!a.expires || parseISODate(a.expires) >= todayDateOnly()));

  // Leaderboard: points from approved submissions; sample names only while there are none.
  leaderboard = {};
  for (const kind of ['shops', 'events', 'commodities']) {
    for (const item of c[kind]) {
      const who = String(item.addedBy || '').slice(0, 40);
      if (who) leaderboard[who] = (leaderboard[who] || 0) + POINTS[kind];
    }
  }
  leaderboardIsSample = !Object.keys(leaderboard).length;
  if (leaderboardIsSample) leaderboard = { ...(smp.leaderboard || {}) };
}

let leaderboardIsSample = false;
const SAMPLE_BADGE = '<span class="text-[9.5px] font-semibold px-1.5 py-0.5 rounded-md shrink-0" style="background:var(--surface-2); color:var(--muted); border:1px dashed var(--border);" title="Made-up example — not a real listing">Example</span>';


// Opens a pre-filled GitHub issue for the submission. Must be called directly from a click
// handler (no await before it) or browsers will block the new tab as a popup.
function openSubmission(type, data, label) {
  const payload = JSON.stringify({ v: 1, type, data });
  const url = `https://github.com/${REPO}/issues/new?template=submission.yml`
    + `&title=${encodeURIComponent('[MaList] ' + label.slice(0, 80))}`
    + `&payload=${encodeURIComponent(payload)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ---------- Boot ----------
window.onload = async function () {
  applySavedTheme();
  // Draw the page from local data first; prayer times and weather fill in when they
  // arrive, so a slow or failing API never leaves the whole page blank.
  try { await loadData(); } catch (e) { console.warn('loadData failed:', e); }
  try { updatePersonaUI(); } catch (e) { console.warn('updatePersonaUI failed:', e); }
  try { renderAll(); } catch (e) { console.warn('renderAll failed:', e); }
  try { startEventTicker(); } catch (e) { console.warn('startEventTicker failed:', e); }
  try { startTransitTicker(); } catch (e) { console.warn('startTransitTicker failed:', e); }
  registerServiceWorker();
  loadPrayerData()
    .catch(e => console.warn('loadPrayerData failed:', e))
    .then(() => { try { startPrayerTicker(); } catch (e) { console.warn('startPrayerTicker failed:', e); } });
  loadWeather().catch(e => console.warn('loadWeather failed:', e));
};

// ---------- PWA: service worker registration ----------
// The manifest and all icons are inlined as data URIs above, so this HTML file
// is the only asset needed for install/home-screen support. sw.js is the one
// piece that CANNOT be inlined: browsers refuse to register a service worker
// from a data: URL (a deliberate security restriction, not a limitation of this
// build) — it must be fetched as a real same-origin script file. Also requires
// real http/https hosting; registration silently no-ops on file:// or in most
// sandboxed preview iframes, and only takes effect on real deployment.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  navigator.serviceWorker.register('./sw.js')
    .then(reg => console.log('MaList: service worker registered', reg.scope))
    .catch(err => console.warn('MaList: service worker registration failed (expected in preview/file:// contexts):', err));
}

// ---------- Prayer Times (live, from Aladhan's public astronomical API) ----------
// Aladhan (api.aladhan.com) is a free, documented public API — no scraping/ToS
// concerns like rtl.mv. We fetch once per day per location and cache the result;
// if the fetch fails (offline, CORS, etc.) we fall back to a labeled estimate
// rather than silently showing possibly-wrong numbers as if they were live.
// Method 99 + methodSettings=18,null,18 = Fajr 18°/Isha 18°, the convention most
// Maldives-focused prayer sites (IslamicFinder, Muslim and Quran) report using.
// Malé and Hulhumalé (Ph.1/Ph.2) sit ~5km apart, close enough that solar-angle-based
// prayer times are effectively identical — so this is one shared location/chip
// rather than a per-zone widget, using Malé itself as the reference point.
const PRAYER_LOCATION = { city: 'Greater Malé', lat: 4.1755, lng: 73.5093 };
// Minute adjustments passed to Aladhan's `tune` option, to line the calculated times up
// with the official timetable published by the Maldives Ministry of Islamic Affairs.
// All zero until checked: compare a few days against the official times and set the
// difference here (e.g. dhuhr: 2 means two minutes later than calculated).
const PRAYER_TUNE = { fajr: 0, sunrise: 0, dhuhr: 0, asr: 0, maghrib: 0, isha: 0 };
// Fallback estimate only — used if the live API call fails. Sourced from public
// prayer-time aggregators as a rough same-day approximation, NOT a live value.
const prayerFallback = { fajr: '04:43', sunrise: '06:02', dhuhr: '12:10', asr: '15:37', maghrib: '18:20', isha: '19:32' };
let prayerData = null; // populated by fetchPrayerData()
let prayerSource = 'pending'; // 'live' | 'fallback'

const prayerOrder = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];
const prayerCountdownOrder = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']; // sunrise isn't a prayer; excluded from "next" countdown
const prayerLabels = { fajr: 'Fajr', sunrise: 'Sunrise', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
let prayerTickHandle = null;

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

function cleanAladhanTime(s) { return s.split(' ')[0]; } // strips "(+05)" timezone suffix

async function fetchPrayerData() {
  const { lat, lng } = PRAYER_LOCATION;
  const today = new Date();
  const dateStr = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
  try {
    const res = await fetch(`https://api.aladhan.com/v1/timings/${dateStr}?latitude=${lat}&longitude=${lng}&method=99&methodSettings=18,null,18&tune=${[0, PRAYER_TUNE.fajr, PRAYER_TUNE.sunrise, PRAYER_TUNE.dhuhr, PRAYER_TUNE.asr, PRAYER_TUNE.maghrib, 0, PRAYER_TUNE.isha, 0].join(',')}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const t = json.data.timings;
    prayerData = {
      fajr: cleanAladhanTime(t.Fajr), sunrise: cleanAladhanTime(t.Sunrise), dhuhr: cleanAladhanTime(t.Dhuhr),
      asr: cleanAladhanTime(t.Asr), maghrib: cleanAladhanTime(t.Maghrib), isha: cleanAladhanTime(t.Isha)
    };
    prayerSource = 'live';
  } catch (e) {
    console.warn('Live prayer times unavailable, using fallback estimate:', e);
    prayerData = { ...prayerFallback };
    prayerSource = 'fallback';
  }
}

async function loadPrayerData() {
  await fetchPrayerData();
}

// Cached refs + last values: only the countdown needs writing every second,
// the prayer-name/time/source fields change at most once per prayer.
let _prayerEls = null, _lastPrayerKey = null;

function tickPrayerCountdown() {
  if (!prayerData) return;
  if (!_prayerEls) {
    _prayerEls = {
      chipName: document.getElementById('prayerChipName'),
      chipTime: document.getElementById('prayerChipTime'),
      chipCountdown: document.getElementById('prayerChipCountdown'),
      chipLiveDot: document.getElementById('prayerChipLiveDot'),
      modalName: document.getElementById('prayerModalNextName'),
      modalTime: document.getElementById('prayerModalNextTime'),
      modalCountdown: document.getElementById('prayerModalCountdown'),
      modalSource: document.getElementById('prayerModalSourceNote')
    };
  }
  const data = prayerData;
  const now = new Date();
  const nowSecs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  let nextPrayer = null, targetSecs = null;
  for (const p of prayerCountdownOrder) {
    const secs = timeToMinutes(data[p]) * 60;
    if (secs > nowSecs) { nextPrayer = p; targetSecs = secs; break; }
  }
  let wrapsToTomorrow = false;
  if (!nextPrayer) { nextPrayer = prayerCountdownOrder[0]; targetSecs = timeToMinutes(data[nextPrayer]) * 60 + 86400; wrapsToTomorrow = true; }

  const diff = targetSecs - nowSecs;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;

  const stamp = `${nextPrayer}|${wrapsToTomorrow}|${prayerSource}`;
  if (stamp !== _lastPrayerKey) {
    const label = prayerLabels[nextPrayer] + (wrapsToTomorrow ? ' (tmrw)' : '');
    _prayerEls.chipName.textContent = label;
    _prayerEls.chipTime.textContent = data[nextPrayer];
    _prayerEls.modalName.textContent = prayerLabels[nextPrayer] + (wrapsToTomorrow ? ' (tomorrow)' : '');
    _prayerEls.modalTime.textContent = data[nextPrayer];
    _prayerEls.chipLiveDot.classList.toggle('hidden', prayerSource !== 'live');
    if (_prayerEls.modalSource) _prayerEls.modalSource.textContent = prayerSource === 'live' ? 'Calculated by Aladhan — may differ by a few minutes from the official Ministry of Islamic Affairs timetable' : 'Estimated (offline fallback)';
    renderPrayerModalList(nextPrayer);
    _lastPrayerKey = stamp;
  }
  const countdownText = `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  _prayerEls.chipCountdown.textContent = countdownText;
  _prayerEls.modalCountdown.textContent = countdownText;
}

function renderPrayerModalList(nextPrayer) {
  const list = document.getElementById('prayerModalList');
  if (!list || !prayerData) return;
  list.innerHTML = prayerOrder.map(p => {
    const isNext = p === nextPrayer;
    return `<div class="flex items-center justify-between px-3 py-2 rounded-lg ${isNext ? '' : 'hairline border'}" style="${isNext ? 'background:var(--accent-soft); border:1px solid var(--accent);' : ''}">
      <span class="font-medium ${isNext ? 'accent' : 'ink'}">${prayerLabels[p]}</span>
      <span class="mono font-semibold ${isNext ? 'accent' : 'ink'}">${prayerData[p]}</span>
    </div>`;
  }).join('');
}

function startPrayerTicker() {
  tickPrayerCountdown();
  if (prayerTickHandle) clearInterval(prayerTickHandle);
  prayerTickHandle = setInterval(tickPrayerCountdown, 1000);
}

// ---------- Fixed Bus & Ferry Network (Greater Malé) ----------
// Ferry entry is a simple fixed timetable. Bus routes (R1–R12) are modeled as
// headway/interval services with day-specific rules, matching how RTL actually
// operates: a midday pause around Friday prayers, reduced/offline overnight
// service on most routes, and flight-aligned spacing for airport routes.
const ferryRoute = { id: 'ferry-male-ph1', code: null, name: 'Ferry · Malé ⇄ Ph 1', mode: 'ferry', departures: ['14:00', '14:15', '14:30', '14:45', '15:00'] };

const busRoutes = [
  { code: 'R1', name: 'West Park (Malé) ⇄ Hulhumalé Phase 1', hours: '24/7', weekdayInterval: [15, 20], lateNight: { type: 'reduced', interval: [45, 60], window: ['00:30', '05:00'] }, fridayRule: 'Pause 10:45–13:30 · Peak 15 min after 13:30', saturdayRule: 'Flattened morning · Peak 15 min (16:00–22:00)' },
  { code: 'R2', name: 'Carnival Area (Malé) ⇄ Hulhumalé Phase 1', hours: '05:45–00:00', weekdayInterval: [20, 20], lateNight: { type: 'stopped', window: ['00:00', '05:45'] }, fridayRule: 'Pause 10:45–13:30 · Resumes 20 min', saturdayRule: 'Standard 20 min loop · Evening surge deployment' },
  { code: 'R3', name: 'West Park (Malé) ⇄ Velana Int’l Airport', hours: '24/7', weekdayInterval: [20, 30], lateNight: { type: 'flightAligned', interval: [60, 120], window: ['00:00', '05:00'] }, fridayContinuous: true, fridayRule: 'Continuous highway flow · Standard flight-sync', saturdayRule: 'Standard flight-sync adjustments' },
  { code: 'R4', name: 'Hulhumalé Phase 1 ⇄ Velana Int’l Airport', hours: '24/7', weekdayInterval: [30, 30], lateNight: { type: 'flightAligned', interval: [60, 120], window: ['00:00', '05:00'] }, fridayContinuous: true, fridayRule: 'Continuous highway flow · Standard flight-sync', saturdayRule: 'Standard flight-sync adjustments' },
  { code: 'R5', name: 'Hulhumalé Phase 1 ⇄ Hulhumalé Phase 2', hours: '05:45–00:00', weekdayInterval: [15, 15], lateNight: { type: 'stopped', window: ['00:00', '05:45'] }, fridayRule: 'Pause 10:45–13:30 · Resumes 15 min loop', saturdayRule: 'Standard 15 min internal loop' },
  { code: 'R7', name: 'West Park (Malé) ⇄ Hulhumalé Phase 2 (Hiya)', hours: '24/7', weekdayInterval: [15, 20], lateNight: { type: 'reduced', interval: [45, 60], window: ['00:30', '05:00'] }, fridayRule: 'Pause 10:45–13:30 · Peak 15 min after 13:30', saturdayRule: 'Flattened morning · Peak 15 min (16:00–22:00)' },
  { code: 'R8', name: 'Carnival Area (Malé) ⇄ Hulhumalé Phase 2 (Hiya)', hours: '05:45–00:00', weekdayInterval: [20, 20], lateNight: { type: 'stopped', window: ['00:00', '05:45'] }, fridayRule: 'Pause 10:45–13:30 · Resumes 20 min', saturdayRule: 'Standard 20 min loop · Evening surge deployment' },
  { code: 'R9', name: 'Hulhumalé Phase 2 ⇄ Velana Int’l Airport', hours: '24/7', weekdayInterval: [30, 30], lateNight: { type: 'flightAligned', interval: [60, 120], window: ['00:00', '05:00'] }, fridayContinuous: true, fridayRule: 'Continuous highway flow · Standard flight-sync', saturdayRule: 'Standard flight-sync adjustments' },
  { code: 'R10', name: 'Orchid Route · Malé Minibus Loop', hours: '05:00–00:00', weekdayInterval: [10, 15], lateNight: { type: 'stopped', window: ['00:00', '05:00'] }, fridayRule: 'Pause 10:45–13:30 · Resumes 10–15 min loop', saturdayRule: 'Low morning frequency · Regular afternoon loops' },
  { code: 'R11', name: 'Ameenee Route · Malé Minibus Loop', hours: '05:00–00:00', weekdayInterval: [10, 15], lateNight: { type: 'stopped', window: ['00:00', '05:00'] }, fridayRule: 'Pause 10:45–13:30 · Resumes 10–15 min loop', saturdayRule: 'Low morning frequency · Regular afternoon loops' },
  { code: 'R12', name: 'Sosun Route · Malé Minibus Loop', hours: '05:00–00:00', weekdayInterval: [10, 15], lateNight: { type: 'stopped', window: ['00:00', '05:00'] }, fridayRule: 'Pause 10:45–13:30 · Resumes 10–15 min loop', saturdayRule: 'Low morning frequency · Regular afternoon loops' }
];

const RTL_TICKET_URL = 'https://rtl.mv/#/busticket';
const RTL_ANNOUNCEMENTS_URL = 'https://x.com/MTCCPlc';

function parseHHMM(t) {
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}
function fmtHHMM(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDuration(mins) {
  const m = Math.max(0, Math.round(mins));
  const h = Math.floor(m / 60), r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${r}m`;
}
function timeStrToMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function inClockWindow(mins, startStr, endStr) {
  const start = timeStrToMins(startStr), end = timeStrToMins(endStr === '00:00' ? '24:00' : endStr);
  return mins >= start && mins < end;
}

// Applies the Friday-prayer pause / overnight-service rules to a bus route for "now".
function minsToDate(mins, now) {
  const d = new Date(now);
  d.setHours(Math.floor(mins / 60) % 24, mins % 60, 0, 0);
  return d;
}

function busRouteState(route, now) {
  const day = now.getDay(); // 0 Sun ... 5 Fri, 6 Sat
  const mins = now.getHours() * 60 + now.getMinutes();
  const FRI_START = 10 * 60 + 45, FRI_END = 13 * 60 + 30;

  // 1) Friday prayer pause overrides everything except continuous-flow airport routes
  if (day === 5 && mins >= FRI_START && mins < FRI_END && !route.fridayContinuous) {
    return { state: 'paused', label: `Paused for Friday prayers`, resumeAt: minsToDate(FRI_END, now), dot: 'stale' };
  }

  // 2) Overnight window handling
  if (route.lateNight && inClockWindow(mins, route.lateNight.window[0], route.lateNight.window[1])) {
    if (route.lateNight.type === 'stopped') {
      const [wh, wm] = route.lateNight.window[1].split(':').map(Number);
      return { state: 'offline', label: 'Offline overnight', resumeAt: minsToDate(wh * 60 + wm, now), dot: 'stale' };
    }
    if (route.lateNight.type === 'reduced') {
      return { state: 'reduced', label: `Every ${route.lateNight.interval[0]}–${route.lateNight.interval[1]} min`, note: 'Reduced overnight frequency', interval: route.lateNight.interval, dot: 'good' };
    }
    if (route.lateNight.type === 'flightAligned') {
      return { state: 'flight', label: `Every ${route.lateNight.interval[0]}–${route.lateNight.interval[1]} min`, note: 'Flight-aligned overnight spacing', interval: route.lateNight.interval, dot: 'good' };
    }
  }

  // 3) Normal daytime operation, with a day-specific rule note
  const note = day === 5 ? route.fridayRule : (day === 6 ? route.saturdayRule : null);
  const [lo, hi] = route.weekdayInterval;
  return { state: 'active', label: lo === hi ? `Every ${lo} min` : `Every ${lo}–${hi} min`, note, interval: route.weekdayInterval, dot: 'good' };
}

// Estimates a "next departure in ~Xm" for headway-based routes, using the lower
// bound of the current interval as a best-case boarding wait (no fixed timetable).
function estimateNextInMins(interval) {
  const lo = interval[0];
  const nowMins = new Date().getMinutes();
  return lo - (nowMins % lo === 0 ? 0 : nowMins % lo);
}

function renderBusRouteCard(route, st, now) {
  const dotColor = st.dot === 'stale' ? 'var(--stale)' : 'var(--good)';
  const isPaused = st.state === 'paused' || st.state === 'offline';

  let line = st.label;
  let noteLine = st.note || '';

  if (st.interval) {
    const eta = estimateNextInMins(st.interval);
    line = `${st.label} · next ~${eta}m`;
  }

  if (isPaused && st.resumeAt) {
    const diffSecs = Math.max(0, Math.round((st.resumeAt - now) / 1000));
    const h = Math.floor(diffSecs / 3600);
    const m = Math.floor((diffSecs % 3600) / 60);
    const s = diffSecs % 60;
    noteLine = `Resumes ${fmtHHMM(st.resumeAt)} · in ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }

  const cardStyle = isPaused
    ? `background:color-mix(in srgb, var(--stale) 16%, var(--surface-2)); border:1px solid color-mix(in srgb, var(--stale) 35%, var(--border));`
    : '';

  return `
  <div class="${isPaused ? '' : 'surface-2'} p-3 rounded-lg space-y-1.5" style="${cardStyle}">
    <div class="flex justify-between items-center gap-2">
      <span class="font-medium ink-soft text-[11px] flex items-center gap-1.5">
        <span class="mono text-[10px] px-1.5 py-0.5 rounded accent-soft shrink-0">${route.code}</span>
        🚌 ${route.name}
      </span>
      <span class="w-2 h-2 rounded-full shrink-0" style="background:${dotColor}"></span>
    </div>
    <p class="mono text-[11.5px] font-semibold ${st.state === 'active' || st.state === 'reduced' || st.state === 'flight' ? 'accent' : ''}" style="${isPaused ? 'color:var(--stale)' : ''}">
      ${line}
    </p>
    ${noteLine ? `<p class="text-[10px] font-medium" style="color:${isPaused ? 'var(--stale)' : 'var(--muted)'}">${noteLine}</p>` : ''}
  </div>`;
}

function renderFerryCard(route, now) {
  const upcoming = route.departures.map(parseHHMM).find(d => d > now);

  if (upcoming) {
    const line = `Next ${fmtHHMM(upcoming)} · in ${fmtDuration((upcoming - now) / 60000)}`;
    return `
    <div class="surface-2 p-3 rounded-lg space-y-1.5">
      <div class="flex justify-between items-center">
        <span class="font-medium ink-soft text-[11px]">⛴️ ${route.name}</span>
        <span class="w-2 h-2 rounded-full shrink-0" style="background:var(--good)"></span>
      </div>
      <p class="mono text-[11.5px] font-semibold accent">${line}</p>
    </div>`;
  }

  // Service ended for today — resumes with tomorrow's first departure
  const firstTomorrow = parseHHMM(route.departures[0]);
  firstTomorrow.setDate(firstTomorrow.getDate() + 1);
  const diffSecs = Math.max(0, Math.round((firstTomorrow - now) / 1000));
  const h = Math.floor(diffSecs / 3600), m = Math.floor((diffSecs % 3600) / 60), s = diffSecs % 60;

  return `
  <div class="p-3 rounded-lg space-y-1.5" style="background:color-mix(in srgb, var(--stale) 16%, var(--surface-2)); border:1px solid color-mix(in srgb, var(--stale) 35%, var(--border));">
    <div class="flex justify-between items-center">
      <span class="font-medium ink-soft text-[11px]">⛴️ ${route.name}</span>
      <span class="w-2 h-2 rounded-full shrink-0" style="background:var(--stale)"></span>
    </div>
    <p class="mono text-[11.5px] font-semibold" style="color:var(--stale)">Service ended for today</p>
    <p class="text-[10px] font-medium" style="color:var(--stale)">Resumes ${fmtHHMM(firstTomorrow)} · in ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s</p>
  </div>`;
}

// Cached DOM refs + last-rendered signatures so the 1s ticker only touches the
// DOM when output actually changed (most seconds it hasn't).
let _transitGridEl = null, _transitActionsEl = null;
let _lastTransitHTML = '', _lastAnyPaused = null;

function renderTransit() {
  if (!_transitGridEl) _transitGridEl = document.getElementById('transitGrid');
  if (!_transitActionsEl) _transitActionsEl = document.getElementById('transitActions');
  if (!_transitGridEl) return;

  const now = new Date();

  // Compute each route's state once and reuse it for both the card and the
  // paused-summary check (previously busRouteState ran twice per route per tick).
  const states = busRoutes.map(r => busRouteState(r, now));
  const html = [renderFerryCard(ferryRoute, now), ...busRoutes.map((r, i) => renderBusRouteCard(r, states[i], now))].join('');

  if (html !== _lastTransitHTML) {
    _transitGridEl.innerHTML = html;
    _lastTransitHTML = html;
  }

  const anyPaused = states.some(st => st.state === 'paused' || st.state === 'offline');
  if (_transitActionsEl && anyPaused !== _lastAnyPaused) {
    const announceBtnStyle = anyPaused
      ? 'background:var(--accent-soft); color:var(--accent); border:1px solid var(--border);'
      : 'background:var(--surface-2); color:var(--ink-soft); border:1px solid var(--border);';
    _transitActionsEl.innerHTML = `
      <a href="${RTL_TICKET_URL}" target="_blank" rel="noopener noreferrer" class="flex-1 text-center btn-primary text-xs font-semibold py-2.5 rounded-lg transition">Buy on RTL ↗</a>
      <a href="${RTL_ANNOUNCEMENTS_URL}" target="_blank" rel="noopener noreferrer" class="flex-1 text-center text-xs font-semibold py-2.5 rounded-lg transition" style="${announceBtnStyle}">${anyPaused ? 'Some routes paused/offline — check announcements ↗' : 'Check announcements ↗'}</a>
    `;
    _lastAnyPaused = anyPaused;
  }
}

let transitTickHandle = null;
function startTransitTicker() {
  renderTransit();
  if (transitTickHandle) clearInterval(transitTickHandle);
  transitTickHandle = setInterval(renderTransit, 1000); // recompute countdowns/paused state every second
}

// ---------- Ticker lifecycle ----------
// Three 1s intervals running in a backgrounded tab is wasted battery on mobile,
// so suspend them while the page is hidden and resync immediately on return
// (the countdowns are all computed from Date.now(), so no drift on resume).
function suspendTickers() {
  if (transitTickHandle) { clearInterval(transitTickHandle); transitTickHandle = null; }
  if (eventTickHandle) { clearInterval(eventTickHandle); eventTickHandle = null; }
  if (prayerTickHandle) { clearInterval(prayerTickHandle); prayerTickHandle = null; }
}
function resumeTickers() {
  startTransitTicker();
  startEventTicker();
  if (prayerData) startPrayerTicker();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) suspendTickers(); else resumeTickers();
});

function toggleModal(id) { document.getElementById(id).classList.toggle('hidden'); }

// Every modal (scanner, add-place, add-event, event/prayer detail, leaderboard, SIM
// compare, ATM locator) closes the same way: click the dark backdrop outside the
// card. Rather than repeat "if(event.target===this) toggleModal(...)" on each of the
// 8 modal divs, one delegated listener here covers all of them — including any
// future modal that just gets the .modal-backdrop class.
document.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-backdrop')) {
    e.target.classList.add('hidden');
  }
});

// Tourist SIM packages, compared side by side by carrier. Ooredoo's lineup is the
// same for physical SIM and eSIM, so it's defined once and reused under both types;
// Dhiraagu's differs, so it's defined separately per type. Fields are typed (data/
// voice/sms/validity/extras) rather than free-text so each renders with a matching
// icon — add/edit numbers here, the toggle and both columns render off this object.
const OOREDOO_PACKAGES = [
  { name: 'Tourist $40', price: '$40', priceNote: '≈ MVR 616.8/mo',
    data: '20 GB', voice: '150 min', extras: ['MVR 100 Credit', 'Pay as you go calls & SMS'] },
  { name: 'Tourist $50', price: '$50', priceNote: '≈ MVR 771/mo',
    data: '100 GB (30 reg + 70 social)', voice: '300 min', extras: ['Pay as you go calls & SMS'] }
];
const SIM_PACKAGES = {
  physical: {
    ooredoo: OOREDOO_PACKAGES,
    dhiraagu: [
      { name: 'Traveler Lite', price: '$40', priceNote: '≈ MVR 616.8',
        data: '20 GB', voice: '150 min', sms: '150 SMS', validity: '10 days', extras: ['$6.50 Allowance'] },
      { name: 'Traveler Premium', price: '$50', priceNote: '≈ MVR 771',
        data: '30 GB + 70 GB social', voice: '300 min', sms: '300 SMS', validity: '30 days', extras: ['$9.50 Allowance'] },
      { name: 'Traveler MIFI Pack', price: '$100', priceNote: '≈ MVR 1542',
        data: '125 GB', validity: '30 days', extras: ['Includes MIFI device'] }
    ]
  },
  esim: {
    ooredoo: OOREDOO_PACKAGES,
    dhiraagu: [
      { name: 'Traveler Premium', price: '$50', data: '100 GB', voice: '300 min', sms: '300 SMS' },
      { name: 'Traveler Lite', price: '$40', data: '20 GB', voice: '150 min', sms: '150 SMS' }
    ]
  }
};
const SIM_CARRIER_INFO = {
  ooredoo: { label: 'Ooredoo', color: '#C4122F', url: 'https://www.ooredoo.mv/mobile/tourist-plan' },
  dhiraagu: { label: 'Dhiraagu', color: '#00AEEF', url: 'https://www.dhiraagu.com.mv/tourist-sim' }
};
let activeSimType = 'physical';

function setSimType(type) {
  activeSimType = type;
  renderSimCompare();
}

// Small inline icon set for the spec rows, kept local to this feature.
const SIM_ICONS = {
  data: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20h.01" /><path d="M7 20v-4" /><path d="M12 20v-8" /><path d="M17 20V8" /><path d="M22 4v16" /></svg>',
  voice: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384" /></svg>',
  sms: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2z" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg>',
  validity: '<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4" /><path d="M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" /></svg>'
};

function simSpecRow(kind, value) {
  if (!value) return '';
  return `<div class="flex items-center gap-1.5 accent">${SIM_ICONS[kind]}<span class="font-semibold text-xs" style="color:var(--ink);">${value}</span></div>`;
}

function simPackageCard(pkg, color) {
  const specRows = [simSpecRow('data', pkg.data), simSpecRow('voice', pkg.voice), simSpecRow('sms', pkg.sms), simSpecRow('validity', pkg.validity)]
    .filter(Boolean).join('');
  const extras = (pkg.extras && pkg.extras.length)
    ? `<div class="flex flex-wrap gap-1.5 pt-0.5">${pkg.extras.map(e => `<span class="text-[10px] font-medium px-2 py-0.5 rounded-full" style="background:var(--surface-2); color:var(--ink-soft);">${e}</span>`).join('')}</div>` : '';
  return `<div class="card p-0 cursor-pointer overflow-hidden h-full">
    <div class="flex h-full">
      <div class="w-1 shrink-0" style="background:${color};"></div>
      <div class="p-3.5 space-y-2.5 flex-1 min-w-0 flex flex-col">
        <div class="flex items-start justify-between gap-2">
          <p class="font-semibold text-sm leading-tight">${pkg.name}</p>
          <div class="text-right shrink-0 rounded-lg px-2.5 py-1" style="background:color-mix(in srgb, ${color} 12%, transparent);">
            <p class="font-bold text-base leading-none" style="color:${color};">${pkg.price}</p>
            ${pkg.priceNote ? `<p class="text-[9px] muted mt-0.5 leading-none">${pkg.priceNote}</p>` : ''}
          </div>
        </div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-1.5">${specRows}</div>
        ${extras}
      </div>
    </div>
  </div>`;
}

function simCarrierHeader(info) {
  return `<div class="flex items-center gap-2">
    <div class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 font-bold text-[11px]" style="background:${info.color}; color:#fff;">${info.label[0]}</div>
    <p class="serif font-semibold text-sm" style="color:${info.color};">${info.label}</p>
  </div>`;
}

function renderSimCompare() {
  const chips = document.getElementById('simTypeChips');
  const grid = document.getElementById('simCompareGrid');
  const types = [['physical', 'Physical SIM'], ['esim', 'eSIM']];
  chips.innerHTML = types.map(([k, label]) =>
    `<button onclick="setSimType('${k}')" class="zone-chip ${k === activeSimType ? 'active' : ''} py-1.5 px-3.5 rounded-lg whitespace-nowrap">${label}</button>`
  ).join('');

  const ooInfo = SIM_CARRIER_INFO.ooredoo, dhInfo = SIM_CARRIER_INFO.dhiraagu;
  const ooPkgs = SIM_PACKAGES[activeSimType].ooredoo || [];
  const dhPkgs = SIM_PACKAGES[activeSimType].dhiraagu || [];
  const rowCount = Math.max(ooPkgs.length, dhPkgs.length);

  let html = `<div class="grid grid-cols-2 gap-4">${simCarrierHeader(ooInfo)}${simCarrierHeader(dhInfo)}</div>`;

  // Each row pairs one Ooredoo package with its Dhiraagu counterpart in a single
  // CSS grid row — grid's default row-stretch then makes both cards equal height
  // for free, no JS height-measuring needed. A missing counterpart just leaves
  // an empty cell rather than breaking the pairing.
  for (let i = 0; i < rowCount; i++) {
    const left = ooPkgs[i] ? simPackageCard(ooPkgs[i], ooInfo.color) : '<div></div>';
    const right = dhPkgs[i] ? simPackageCard(dhPkgs[i], dhInfo.color) : '<div></div>';
    html += `<div class="grid grid-cols-2 gap-4 items-stretch">${left}${right}</div>`;
  }

  if (activeSimType === 'esim') {
    html += `<div class="grid grid-cols-2 gap-4"><div></div><p class="text-[10px] muted">Rates inclusive of 8% GST · Order is non-refundable.</p></div>`;
  }

  html += `<div class="grid grid-cols-2 gap-4 pt-1">
    <a href="${ooInfo.url}" target="_blank" rel="noopener noreferrer" class="sim-cta text-xs font-semibold px-4 py-2.5 rounded-lg transition w-full block text-center" style="background:${ooInfo.color}; color:#fff;">Go to ${ooInfo.label} tourist page →</a>
    <a href="${dhInfo.url}" target="_blank" rel="noopener noreferrer" class="sim-cta text-xs font-semibold px-4 py-2.5 rounded-lg transition w-full block text-center" style="background:${dhInfo.color}; color:#fff;">Go to ${dhInfo.label} tourist page →</a>
  </div>`;

  grid.innerHTML = html;
}

function openSimPackages() {
  renderSimCompare();
  document.getElementById('simPackagesModal').classList.remove('hidden');
}

// Weather icon set — hand-drawn to match the app's icon style (outline, currentColor)
// rather than pulling an icon font, so day/night variants are just glyph swaps.
const WEATHER_ICONS = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 0 9z"/></svg>',
  cloudSun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M12 3v1.5"/><path d="m6.6 6.6 1.06 1.06"/><path d="M3 13h1.5"/><circle cx="10" cy="11" r="3"/><path d="M17.5 19H9a5 5 0 0 1-.5-9.98"/><path d="M17 19a4 4 0 0 0 0-8h-.3"/></svg>',
  cloudMoon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M13.5 3.55a5 5 0 0 0 4.9 6.45"/><path d="M17.5 19H9a5 5 0 0 1-.5-9.98"/><path d="M17 19a4 4 0 0 0 0-8h-.3"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/><path d="M17.5 10.5A4.5 4.5 0 0 0 17 1.6h-.3A7 7 0 1 0 9 14h8.5"/></svg>',
  thunder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M17.5 10.5A4.5 4.5 0 0 0 17 1.6h-.3A7 7 0 1 0 9 14h8.5"/><path d="m13 12-3 5h4l-3 5"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full"><path d="M3 8h18"/><path d="M5 12h14"/><path d="M3 16h18"/></svg>'
};

// Maps Open-Meteo's WMO weather codes to an icon, with a day/night variant where
// one exists (clear and partly-cloudy look different at night; rain/fog/storm don't).
function weatherIconFor(code, isDay) {
  if (code === 0) return isDay ? WEATHER_ICONS.sun : WEATHER_ICONS.moon;
  if (code === 1 || code === 2) return isDay ? WEATHER_ICONS.cloudSun : WEATHER_ICONS.cloudMoon;
  if (code === 3) return WEATHER_ICONS.cloud;
  if (code === 45 || code === 48) return WEATHER_ICONS.fog;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return WEATHER_ICONS.rain;
  if (code >= 95) return WEATHER_ICONS.thunder;
  return WEATHER_ICONS.cloud;
}
function weatherLabelFor(code) {
  const labels = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
    80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers', 95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm' };
  return labels[code] || 'Cloudy';
}

async function loadWeather() {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=4.1755&longitude=73.5093&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day&timezone=Indian%2FMaldives&forecast_days=2');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const cur = json.current, hourly = json.hourly;

    document.getElementById('weatherChipIcon').innerHTML = weatherIconFor(cur.weather_code, cur.is_day === 1);
    document.getElementById('weatherChipTemp').textContent = Math.round(cur.temperature_2m);

    // Find the hourly slot matching (or just after) the current time, then take
    // the following 6 hours for the modal.
    const nowMs = new Date(cur.time).getTime();
    let startIdx = hourly.time.findIndex(t => new Date(t).getTime() >= nowMs);
    if (startIdx === -1) startIdx = 0;
    const nextHours = [];
    for (let i = 1; i <= 6; i++) {
      const idx = startIdx + i;
      if (idx >= hourly.time.length) break;
      nextHours.push({
        time: new Date(hourly.time[idx]),
        temp: Math.round(hourly.temperature_2m[idx]),
        code: hourly.weather_code[idx],
        isDay: hourly.is_day[idx] === 1
      });
    }
    renderWeatherHourly(nextHours);
  } catch (e) {
    console.warn('Live weather unavailable, using fallback estimate:', e);
    document.getElementById('weatherChipIcon').innerHTML = WEATHER_ICONS.cloudSun;
    document.getElementById('weatherChipTemp').textContent = 30;
    // Fallback: 6 flat estimated hours rather than leaving the modal empty.
    const now = new Date();
    const fallbackHours = Array.from({ length: 6 }, (_, i) => {
      const t = new Date(now.getTime() + (i + 1) * 3600000);
      const hour = t.getHours();
      return { time: t, temp: 29, code: 1, isDay: hour >= 6 && hour < 18 };
    });
    renderWeatherHourly(fallbackHours, true);
  }
}

function renderWeatherHourly(hours, isFallback) {
  const list = document.getElementById('weatherHourlyList');
  if (!hours.length) { list.innerHTML = '<p class="text-xs muted italic col-span-3">Hourly forecast unavailable.</p>'; return; }
  list.innerHTML = hours.map(h => `
    <div class="space-y-1.5 shrink-0 w-14">
      <p class="muted text-[10.5px] font-medium">${h.time.getHours().toString().padStart(2, '0')}:00</p>
      <div class="w-7 h-7 mx-auto accent">${weatherIconFor(h.code, h.isDay)}</div>
      <p class="font-semibold text-sm">${h.temp}°</p>
    </div>
  `).join('');
  document.getElementById('weatherFallbackNote').classList.toggle('hidden', !isFallback);
}

let currentPersona = 'resident';

function setPersona(p) {
  currentPersona = p;
  document.querySelectorAll('.persona-btn').forEach(b => b.classList.toggle('active', b.dataset.persona === p));
  updatePersonaUI();
  // Visitors are more likely to open on "what's on / where to go" than the general
  // feed; residents' default (City Feed) stays the same either way.
  switchTab(p === 'visitor' ? 'events' : 'feed');
}

function updatePersonaUI() {
  const touristBanner = document.getElementById('touristBanner');
  const quickTools = document.getElementById('touristQuickTools');
  const reportBanner = document.getElementById('reportIssueBanner');
  const placesToVisit = document.getElementById('placesToVisitCard');
  const isVisitor = currentPersona === 'visitor';
  if (touristBanner) touristBanner.classList.toggle('hidden', !isVisitor);
  if (quickTools) quickTools.classList.toggle('hidden', !isVisitor);
  if (reportBanner) reportBanner.classList.toggle('hidden', isVisitor);
  // Places to Visit only ever appears as a direct result of dismissing the guide
  // banner (see dismissTouristBanner) — reset it here so switching personas back
  // and forth doesn't leave it stuck open without the person having dismissed anything.
  if (placesToVisit) placesToVisit.classList.add('hidden');
}

// Civic issue reports. Sample reports (data/builtin.json) are shown labelled as examples;
// reports made on this device are kept in localStorage so they survive a reload, and each
// one is also opened as a public GitHub issue — that is where other people actually see it.
let issuesData = [];
const MY_ISSUES_KEY = 'malist-my-issues';
const LIKED_KEY = 'malist-liked-issues';
function readStore(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
let activeIssueCategory = 'pothole';
const ISSUE_CATEGORY_LABELS = { pothole: 'Pothole', streetlight: 'Streetlight', trash: 'Trash pile' };
const ISSUE_CATEGORY_ICONS = {
  pothole: '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>',
  streetlight: '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6" /><path d="M10 22h4" /><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.6.6 1.13 1.28 1.41 2.5" /></svg>',
  trash: '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>'
};

function setIssueCategory(cat) {
  activeIssueCategory = cat;
  document.querySelectorAll('#issueCategoryChips [data-cat]').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
}

function updateIssueLocationHelper() {
  const val = document.getElementById('issueLocation').value.trim();
  document.getElementById('issueLocationHelper').classList.toggle('hidden', val.length > 0);
}

function openIssueDirections() {
  const val = document.getElementById('issueLocation').value.trim();
  if (!val) { showToast('Add a location first'); return; }
  const query = encodeURIComponent(`${val}, Maldives`);
  window.open(`https://www.google.com/maps/search/?api=1&query=${query}`, '_blank', 'noopener,noreferrer');
}

function submitIssueReport() {
  const commentEl = document.getElementById('issueComment');
  const locationEl = document.getElementById('issueLocation');
  const comment = commentEl.value.trim();
  const location = locationEl.value.trim();
  if (!comment) { showToast('Add a short description first'); return; }
  const report = {
    id: 'i' + Date.now(), category: activeIssueCategory, comment,
    location: location || 'Location not specified',
    zone: currentZone === 'all' ? 'male' : currentZone,
    addedBy: 'You', ts: Date.now()
  };
  // Must run straight from the click (no await before it) or the new tab is blocked as a popup.
  const label = ISSUE_CATEGORY_LABELS[report.category] || 'Issue';
  const body = `**${label}** — ${zoneShort[report.zone]}\n\n${comment}\n\n📍 ${report.location}\n\n_Reported via MaList_`;
  window.open(`https://github.com/${REPO}/issues/new?labels=city-issue`
    + `&title=${encodeURIComponent(`[Issue] ${label}: ${report.location}`.slice(0, 120))}`
    + `&body=${encodeURIComponent(body)}`, '_blank', 'noopener,noreferrer');
  writeStore(MY_ISSUES_KEY, [report, ...readStore(MY_ISSUES_KEY, [])].slice(0, 50));
  commentEl.value = '';
  locationEl.value = '';
  updateIssueLocationHelper();
  renderIssuesList();
  showToast('Finish on GitHub to post it publicly');
}

// One like per report per device (tap again to undo), remembered across reloads. Likes are
// only stored locally — the public place to back a report up is its GitHub issue.
function likeIssue(id) {
  const liked = new Set(readStore(LIKED_KEY, []));
  liked.has(id) ? liked.delete(id) : liked.add(id);
  writeStore(LIKED_KEY, [...liked]);
  renderIssuesList();
}

function renderIssuesList() {
  const list = document.getElementById('issuesList');
  if (!list) return;
  const liked = new Set(readStore(LIKED_KEY, []));
  const all = [...readStore(MY_ISSUES_KEY, []), ...issuesData];
  list.innerHTML = all.map(i => {
    const likes = (i.likes || 0) + (liked.has(i.id) ? 1 : 0);
    return `
    <div class="card p-3.5 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <span class="inline-flex items-center gap-1.5 font-semibold accent">${ISSUE_CATEGORY_ICONS[i.category] || ''} <span class="ink">${ISSUE_CATEGORY_LABELS[i.category] || esc(i.category)}</span></span>
        <span class="text-[10px] px-2 py-0.5 rounded-full" style="background:var(--surface-2); color:var(--ink-soft);">${zoneShort[i.zone] || ''}</span>
      </div>
      <p class="leading-relaxed">${esc(i.comment)}</p>
      ${i.location ? `<p class="muted text-[10.5px]">📍 ${esc(i.location)}</p>` : ''}
      <div class="flex items-center justify-between pt-1">
        <span class="muted text-[10px] inline-flex items-center gap-1.5">${i.isSample ? SAMPLE_BADGE : ''}Reported by ${esc(i.addedBy)}</span>
        <button onclick="likeIssue('${esc(i.id)}')" class="flex items-center gap-1 font-semibold ${liked.has(i.id) ? 'accent' : 'muted'}" aria-pressed="${liked.has(i.id)}">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12" /><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" /></svg>
          <span>${likes}</span>
        </button>
      </div>
    </div>
  `;
  }).join('');
}

function openReportIssueModal() {
  renderIssuesList();
  document.getElementById('reportIssueModal').classList.remove('hidden');
}

// "Insider tip" copy for each Places to Visit item — written as an actual local's
// advice (timing, what's genuinely worth doing) rather than a reprinted description
// of what the place is.
const PLACE_RECOMMENDATIONS = {
  friday_mosque: {
    name: 'Old Friday Mosque (Hukuru Miskiy)',
    tip: "Go right after Asr prayer — the late-afternoon light does the coral-stone carvings justice, and the crowds thin out by then. Dress modestly (shoulders and knees covered), and check at the gate before taking photos indoors; not every area allows it. Worth pairing with the short walk to the old royal cemetery next door — it's easy to miss but genuinely atmospheric."
  },
  sultan_park: {
    name: 'Sultan Park & National Museum',
    tip: "Morning, before 10am, is the move — it's the coolest and quietest the park gets under the big trees. Most people rush past the museum's upper floor (royal regalia), but it's actually the best part; give it a proper 30 minutes. Entry is cheap, and it's one of the few genuinely shaded, calm spots in central Malé to just sit for a while."
  },
  rasfannu: {
    name: 'Rasfannu (Artificial Beach)',
    tip: "Sunset, not midday, is when this place actually comes alive — that's when locals show up and the water's comfortable. Modest swimwear only; this is a local beach, not a resort one. The street food carts that set up along the seafront in the evening are honestly better than most sit-down places nearby, so save your appetite."
  }
};

function openPlaceRecommendation(key) {
  const place = PLACE_RECOMMENDATIONS[key];
  if (!place) return;
  document.getElementById('placeRecName').textContent = place.name;
  document.getElementById('placeRecTip').textContent = place.tip;
  document.getElementById('placeRecommendationModal').classList.remove('hidden');
}

function dismissTouristBanner() {
  const el = document.getElementById('touristBanner');
  if (el) el.remove();
  const places = document.getElementById('placesToVisitCard');
  if (places) places.classList.remove('hidden');
}
function openTouristGuide() {
  document.getElementById('touristGuidePage').classList.remove('hidden');
  document.getElementById('touristGuidePage').scrollTop = 0;
  document.body.style.overflow = 'hidden'; // lock background scroll while the full-page guide is open
}
function closeTouristGuide() {
  document.getElementById('touristGuidePage').classList.add('hidden');
  document.body.style.overflow = '';
}

function handleLogoClick() {
  switchTab('feed');
}

// ---------- Event Detail Modal ----------
function openEventFromWidget() {
  if (currentWidgetEventId) openEventDetail(currentWidgetEventId);
}

function openEventDetail(id) {
  const e = eventsData.find(ev => ev.id === id);
  if (!e) return;

  const now = new Date();
  const dt = parseEventClock(e);
  let statusText = null, statusBg = 'var(--accent-soft)', statusInk = 'var(--accent)';
  if (dt) {
    const diffMs = dt - now;
    if (diffMs <= 0 && diffMs > -EVENT_ASSUMED_DURATION_MS) { statusText = '● Happening now'; }
    else if (diffMs > 0) { statusText = `Starts in ${fmtDuration(diffMs / 60000)}`; }
    else { statusText = 'Already happened today'; statusBg = 'var(--surface-2)'; statusInk = 'var(--muted)'; }
  } else {
    const tab = computeEventTab(e, now);
    if (tab === 'past') { statusText = 'Event has ended'; statusBg = 'var(--surface-2)'; statusInk = 'var(--muted)'; }
  }

  const tab = computeEventTab(e, now);
  document.getElementById('eventDetailZoneTag').textContent = (zoneShort[e.zone] || e.zone) + (eventTabLabel[tab] ? ' · ' + eventTabLabel[tab] : '') + (e.isSample ? ' · Example, not a real event' : '');
  document.getElementById('eventDetailTitle').textContent = e.title;
  document.getElementById('eventDetailDescription').textContent = e.description || 'No description provided.';
  document.getElementById('eventDetailTime').textContent = `${formatEventDate(e)} · ${e.time}`;
  document.getElementById('eventDetailLocation').textContent = e.location;
  document.getElementById('eventDetailAddedBy').textContent = e.addedBy || 'Community';

  // Google Maps' search endpoint just needs a URL-encoded text query — no API key,
  // no place-ID lookup needed. Including the event title alongside the location
  // helps disambiguate generic addresses (e.g. "Ground Floor") that alone wouldn't
  // pinpoint a specific venue.
  const mapsQuery = encodeURIComponent(`${e.location}, ${zoneShort[e.zone] || 'Malé'}, Maldives`);
  document.getElementById('eventDetailDirectionsBtn').href = `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`;

  const hostRow = document.getElementById('eventDetailHostedByRow');
  if (e.hostedBy) {
    document.getElementById('eventDetailHostedBy').textContent = e.hostedBy;
    hostRow.classList.remove('hidden');
    hostRow.classList.add('flex');
  } else {
    hostRow.classList.add('hidden');
    hostRow.classList.remove('flex');
  }

  const badge = document.getElementById('eventDetailStatusBadge');
  if (statusText) {
    badge.style.display = 'inline-flex';
    badge.style.background = statusBg;
    badge.style.color = statusInk;
    badge.textContent = statusText;
  } else {
    badge.style.display = 'none';
  }

  document.getElementById('eventDetailModal').classList.remove('hidden');
}


// ---------- Current / Next Event Widget ----------
let eventTickHandle = null;
const EVENT_ASSUMED_DURATION_MS = 3 * 3600 * 1000; // assume 3hr window for "live now" detection

// Only returns a concrete Date for events that are actually happening TODAY
// (per their real startDate/endDate) — previously this assumed every event's
// time string meant "today", which was wrong for anything with a future or
// multi-day date. Events outside today correctly report "no live time" instead
// of a misleading countdown.
function parseEventClock(e) {
  if (computeEventTab(e, new Date()) !== 'today') return null;
  const m = e.time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

let currentWidgetEventId = null;
let _eventWidgetEl = null;
let _lastEventWidgetVisible = null;

function tickEventCountdown() {
  if (!_eventWidgetEl) _eventWidgetEl = document.getElementById('eventWidget');
  const widget = _eventWidgetEl;
  if (!widget) return;
  const now0 = new Date();
  const pool = eventsData.filter(e => (currentZone === 'all' || e.zone === currentZone) && computeEventTab(e, now0) !== 'past');
  if (!pool.length) {
    widget.classList.add('is-hidden');
    currentWidgetEventId = null;
    if (_lastEventWidgetVisible !== false) { _lastEventWidgetVisible = false; }
    return;
  }

  const now = new Date();
  let liveEvent = null, liveStart = null;
  let upcomingEvent = null, upcomingStart = null;

  pool.forEach(e => {
    const dt = parseEventClock(e);
    if (!dt) return;
    const diffMs = dt - now;
    if (diffMs <= 0 && diffMs > -EVENT_ASSUMED_DURATION_MS) {
      if (!liveStart || dt > liveStart) { liveEvent = e; liveStart = dt; }
    } else if (diffMs > 0) {
      if (!upcomingStart || dt < upcomingStart) { upcomingEvent = e; upcomingStart = dt; }
    }
  });

  widget.classList.remove('is-hidden');
  const dot = document.getElementById('eventLiveDot');

  if (liveEvent) {
    const endsAt = new Date(liveStart.getTime() + EVENT_ASSUMED_DURATION_MS);
    const remain = Math.max(0, Math.floor((endsAt - now) / 1000));
    const h = Math.floor(remain / 3600), m = Math.floor((remain % 3600) / 60), s = remain % 60;
    document.getElementById('eventStatusLabel').textContent = 'Happening now';
    document.getElementById('eventNextTitle').textContent = (liveEvent.isSample ? 'Example: ' : '') + liveEvent.title;
    document.getElementById('eventCountdown').textContent = `ends in ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    dot.classList.remove('hidden');
    currentWidgetEventId = liveEvent.id;
  } else if (upcomingEvent) {
    const remain = Math.max(0, Math.floor((upcomingStart - now) / 1000));
    const h = Math.floor(remain / 3600), m = Math.floor((remain % 3600) / 60), s = remain % 60;
    document.getElementById('eventStatusLabel').textContent = 'Next event';
    document.getElementById('eventNextTitle').textContent = (upcomingEvent.isSample ? 'Example: ' : '') + upcomingEvent.title;
    document.getElementById('eventCountdown').textContent = `starts in ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    dot.classList.add('hidden');
    currentWidgetEventId = upcomingEvent.id;
  } else {
    // No parseable clock time in the pool (e.g. "16:00–23:00 daily", 24h times) —
    // surface the soonest event by actual startDate rather than array order.
    const sorted = [...pool].sort((a, b) => (parseISODate(a.startDate) || 0) - (parseISODate(b.startDate) || 0));
    const fallback = sorted[0];
    const fbTab = computeEventTab(fallback, now);
    document.getElementById('eventStatusLabel').textContent = fbTab === 'today' ? 'Happening today' : (eventTabLabel[fbTab] || 'Upcoming event');
    document.getElementById('eventNextTitle').textContent = (fallback.isSample ? 'Example: ' : '') + fallback.title;
    document.getElementById('eventCountdown').textContent = `${formatEventDate(fallback)} · ${fallback.time}`;
    dot.classList.add('hidden');
    currentWidgetEventId = fallback.id;
  }
  if (_lastEventWidgetVisible !== true) {
    _lastEventWidgetVisible = true;
  }
}

function startEventTicker() {
  tickEventCountdown();
  if (eventTickHandle) clearInterval(eventTickHandle);
  eventTickHandle = setInterval(tickEventCountdown, 1000);
}



function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toastText').textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

function switchTab(tab) {
  ['feed', 'directory', 'events', 'priceWiki'].forEach(t => {
    document.getElementById(`section-${t}`).classList.add('hidden');
    const btn = document.querySelector(`[data-tabbtn="${t}"]`);
    if (btn) btn.classList.remove('active');
  });
  document.getElementById(`section-${tab}`).classList.remove('hidden');
  const activeBtn = document.querySelector(`[data-tabbtn="${tab}"]`);
  if (activeBtn) activeBtn.classList.add('active');
  if (tab === 'events') requestAnimationFrame(positionEventPill);
}

function movePill(pillEl, groupEl, activeBtn) {
  if (!pillEl || !activeBtn) return;
  const groupRect = groupEl.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  pillEl.style.width = btnRect.width + 'px';
  pillEl.style.transform = `translateX(${btnRect.left - groupRect.left}px)`;
}
function positionEventPill() {
  movePill(document.getElementById('eventPill'), document.getElementById('eventTabGroup'), document.querySelector('.evt-tab.active'));
}
window.addEventListener('resize', () => { positionEventPill(); });

function setZone(zone) {
  currentZone = zone;
  document.querySelectorAll('.zone-chip').forEach(btn => btn.classList.toggle('active', btn.dataset.zone === zone));
  tickEventCountdown();
  renderAll();
}

function handleSearch() {
  searchQuery = document.getElementById('searchInput').value.toLowerCase().trim();
  document.getElementById('clearSearchBtn').classList.toggle('hidden', searchQuery.length === 0);
  renderAll();
}
function clearSearch() {
  document.getElementById('searchInput').value = '';
  searchQuery = '';
  document.getElementById('clearSearchBtn').classList.add('hidden');
  renderAll();
}

function filterShopCategory(cat) {
  currentCategory = cat;
  document.querySelectorAll('.cat-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.cat === cat));
  renderShops();
}
function filterEvents(tab) {
  currentEventTab = tab;
  document.querySelectorAll('.evt-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.evttab === tab));
  positionEventPill();
  renderEvents();
}

function renderAll() {
  renderFeed(); renderShops(); renderEvents(); renderCommodities(); renderLeaderboard();
}

function placeCard(s, compact) {
  return `
    <div class="card p-4 space-y-2 text-xs">
      <div class="flex justify-between items-start gap-2">
        <h4 class="font-semibold ink serif text-[13.5px]">${esc(s.name)}</h4>
        <span class="inline-flex items-center gap-1.5">${s.isSample ? SAMPLE_BADGE : ''}<span class="eyebrow surface-2 px-2 py-1 rounded-md shrink-0">${zoneShort[s.zone] || s.zone}</span></span>
      </div>
      <p class="text-[11.5px] ink-soft">${esc(s.address)}</p>
      ${compact ? '' : `
      <div class="flex flex-wrap gap-1.5 pt-1">
        ${s.freeFloorDelivery ? '<span class="text-[10px] accent-soft px-2 py-1 rounded-md">Free doorstep</span>' : ''}
        ${s.acceptsViber ? '<span class="text-[10px] surface-2 ink-soft px-2 py-1 rounded-md">Viber slip OK</span>' : ''}
      </div>
      <p class="text-[10px] muted pt-0.5">Added by ${esc(s.addedBy || 'Community')}</p>`}
    </div>`;
}

const ADVISORY_ICON = `<svg class="w-4 h-4 accent shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0" />   <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" /></svg>`;
function renderAdvisories() {
  const el = document.getElementById('advisoriesContainer');
  if (!el) return;
  el.innerHTML = advisories.map(a => `
    <div class="rounded-xl p-4 flex items-start gap-3 text-xs" style="background:var(--accent-soft); border:1px solid var(--border);">
      ${ADVISORY_ICON}
      <div>
        <p class="font-semibold ink">${esc(a.title)}</p>
        <p class="text-[11.5px] ink-soft mt-0.5">${esc(a.text)}</p>
      </div>
    </div>`).join('');
}

function renderFeed() {
  renderAdvisories();
  const feedEvt = document.getElementById('feedEventsContainer');
  const feedShops = document.getElementById('feedShopsContainer');
  const now = new Date();
  const todays = eventsData.filter(e => computeEventTab(e, now) === 'today').slice(0, 2);
  feedEvt.innerHTML = (todays.length ? todays : eventsData.filter(e => computeEventTab(e, now) !== 'past').slice(0, 2)).map(e => `
    <div class="card p-3.5 flex justify-between items-center text-xs cursor-pointer" onclick="openEventDetail('${e.id}')">
      <div class="min-w-0">
        <p class="font-semibold ink serif text-[13px] truncate">${esc(e.title)}</p>${e.isSample ? `<div class="mt-1">${SAMPLE_BADGE}</div>` : ''}
        <p class="text-[11px] muted mt-0.5">${esc(e.location)} · ${esc(e.time)}</p>
      </div>
      <span class="eyebrow accent-soft px-2 py-1 rounded-md shrink-0 ml-2">${zoneShort[e.zone] || e.zone}</span>
    </div>`).join('') || `<p class="text-xs muted italic">No events yet — be the first to add one.</p>`;
  feedShops.innerHTML = shopsData.slice(0, 2).map(s => placeCard(s, true)).join('') || `<p class="text-xs muted italic">No places yet.</p>`;
}

function renderShops() {
  const container = document.getElementById('shopGrid');
  const floorChecked = document.getElementById('filterFloor').checked;
  const viberChecked = document.getElementById('filterViber').checked;
  const filtered = shopsData.filter(s => {
    const matchesZone = currentZone === 'all' || s.zone === currentZone;
    const matchesCat = currentCategory === 'all' || s.category === currentCategory;
    const matchesSearch = !searchQuery || s.name.toLowerCase().includes(searchQuery) || s.address.toLowerCase().includes(searchQuery);
    const matchesFloor = !floorChecked || s.freeFloorDelivery;
    const matchesViber = !viberChecked || s.acceptsViber;
    return matchesZone && matchesCat && matchesSearch && matchesFloor && matchesViber;
  });
  container.innerHTML = filtered.map(s => placeCard(s, false)).join('') ||
    `<p class="col-span-full text-center text-xs muted italic py-8">No places match these filters yet. Try “+ Add place”.</p>`;
}

function renderEvents() {
  const container = document.getElementById('eventsContainer');
  const now = new Date();
  const filtered = eventsData
    .filter(e => {
      const tab = computeEventTab(e, now);
      const matchesZone = currentZone === 'all' || e.zone === currentZone;
      // "All" still hides past events by default — they're not deleted, just not
      // useful to surface; a real admin/history view could show them separately.
      const matchesTab = currentEventTab === 'all' ? tab !== 'past' : tab === currentEventTab;
      const matchesSearch = !searchQuery || e.title.toLowerCase().includes(searchQuery) || e.description.toLowerCase().includes(searchQuery);
      return matchesZone && matchesTab && matchesSearch;
    })
    .sort((a, b) => (parseISODate(a.startDate) || 0) - (parseISODate(b.startDate) || 0));

  container.innerHTML = filtered.map(e => `
    <div class="card p-4 space-y-1.5 text-xs cursor-pointer" onclick="openEventDetail('${e.id}')">
      <div class="flex justify-between items-start gap-2">
        <h4 class="font-semibold ink serif text-[13.5px]">${esc(e.title)}</h4>
        <span class="inline-flex items-center gap-1.5 shrink-0">${e.isSample ? SAMPLE_BADGE : ''}<span class="eyebrow accent-soft px-2 py-1 rounded-md">${zoneShort[e.zone] || e.zone}</span></span>
      </div>
      <p class="text-[11.5px] ink-soft">${esc(e.description)}</p>
      <p class="text-[11px] muted pt-1">${formatEventDate(e)} · ${esc(e.time)} · ${esc(e.location)}</p>
      <p class="text-[10px] muted">Posted by ${esc(e.addedBy || 'Community')}</p>
    </div>`).join('') ||
    `<p class="text-center text-xs muted italic py-8">Nothing here yet for this filter. Try “+ Add event”.</p>`;
}

function renderCommodities() {
  const container = document.getElementById('priceCarousel');
  const filtered = commoditiesData.filter(c => (currentZone === 'all' || c.zone === currentZone) && (!searchQuery || c.name.toLowerCase().includes(searchQuery)));
  const byItem = {};
  filtered.forEach(c => { const key = c.name.toLowerCase(); if (!byItem[key] || c.price < byItem[key].price) byItem[key] = c; });
  const items = Object.values(byItem).sort((a, b) => a.name.localeCompare(b.name));

  container.innerHTML = items.map(c => {
    // An entry with no timestamp has an unknown age, so it is shown as unverified rather than fresh.
    const hasTs = typeof c.ts === 'number' && isFinite(c.ts);
    const days = hasTs ? Math.max(0, Math.floor((Date.now() - c.ts) / 86400000)) : null;
    const stale = !hasTs || days >= 14;
    return `
    <div class="card p-4 space-y-2 text-xs">
      <h4 class="font-semibold ink serif text-[13.5px] flex items-center justify-between gap-2"><span>${esc(c.name)}</span>${c.isSample ? SAMPLE_BADGE : ''}</h4>
      <div class="receipt-line">
        <span class="ink-soft">${esc(c.shop)}</span>
        <span class="font-semibold accent">MVR ${c.price.toFixed(2)}</span>
      </div>
      <div class="flex items-center justify-between pt-1.5 border-t hairline">
        <span class="eyebrow">${zoneShort[c.zone] || c.zone}</span>
        <span class="text-[10.5px] font-medium" style="color:${stale ? 'var(--stale)' : 'var(--good)'}">${!hasTs ? 'Date unknown' : stale ? `Stale · ${days}d ago` : (days === 0 ? 'Verified today' : `Verified ${days}d ago`)}</span>
      </div>
    </div>`;
  }).join('') || `<p class="col-span-full text-center text-xs muted italic py-8">No prices yet for this view. Scan a receipt to add one.</p>`;
}

function renderLeaderboard() {
  const list = document.getElementById('leaderboardList');
  const ranked = Object.entries(leaderboard).sort((a, b) => b[1] - a[1]).slice(0, 8);
  list.innerHTML = ranked.map(([name, pts], i) => `
    <div class="flex justify-between p-3 surface-2 rounded-lg">
      <span class="font-semibold ink">${i + 1}. ${esc(name)}</span>
      <span class="accent font-semibold">${pts.toLocaleString()} pts</span>
    </div>`).join('') + (leaderboardIsSample && ranked.length ? `<p class="text-[10.5px] muted pt-1">These are example names — real contributors appear here once submissions are approved.</p>` : '') || `<p class="text-xs muted italic">No contributors yet.</p>`;
}

// ---------- Add Place ----------
function openAddPlace() { toggleModal('addPlaceModal'); }
function submitPlace() {
  const name = document.getElementById('placeName').value.trim();
  const address = document.getElementById('placeAddress').value.trim();
  if (!name || !address) { showToast('Add a name and address first'); return; }
  openSubmission('place', {
    name, address,
    category: document.getElementById('placeCategory').value,
    zone: document.getElementById('placeZone').value,
    freeFloorDelivery: document.getElementById('placeFloor').checked,
    acceptsViber: document.getElementById('placeViber').checked
  }, name);
  ['placeName', 'placeAddress'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('placeFloor').checked = false;
  document.getElementById('placeViber').checked = false;
  toggleModal('addPlaceModal');
  showToast('Finish on GitHub — it goes live once approved');
}

// ---------- Add Event ----------
function openAddEvent() {
  const dateEl = document.getElementById('eventStartDate');
  if (dateEl && !dateEl.value) dateEl.value = isoDate(todayDateOnly());
  toggleModal('addEventModal');
}
function submitEvent() {
  const title = document.getElementById('eventTitle').value.trim();
  const location = document.getElementById('eventLocation').value.trim();
  const time = document.getElementById('eventTime').value.trim();
  if (!title || !location || !time) { showToast('Fill in title, location & time'); return; }
  openSubmission('event', {
    title, location, time,
    description: document.getElementById('eventDesc').value.trim(),
    hostedBy: document.getElementById('eventHostedBy').value.trim(),
    zone: document.getElementById('eventZone').value,
    startDate: document.getElementById('eventStartDate').value || isoDate(todayDateOnly())
  }, title);
  ['eventTitle', 'eventDesc', 'eventLocation', 'eventTime', 'eventHostedBy'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('eventStartDate').value = '';
  toggleModal('addEventModal');
  showToast('Finish on GitHub — it goes live once approved');
}

// ---------- Submit a price (from a receipt) ----------
function submitPrice() {
  const name = document.getElementById('scanItemName').value.trim();
  const price = parseFloat(document.getElementById('scanItemPrice').value);
  const shop = document.getElementById('scanItemShop').value.trim();
  const zone = document.getElementById('scanItemZone').value;
  if (!name || !shop || isNaN(price) || price <= 0) { showToast('Fill in item, price & shop'); return; }
  openSubmission('price', { name, price, shop, zone }, `${name} — MVR ${price.toFixed(2)}`);
  ['scanItemName', 'scanItemPrice', 'scanItemShop'].forEach(id => document.getElementById(id).value = '');
  toggleModal('scannerModal');
  showToast('Finish on GitHub — it goes live once approved');
}
