// Pulls Meta Ads insights for one ad account and writes data/data.json.
// No dependencies — Node 20+ (global fetch).
//
// Env:
//   META_ACCESS_TOKEN   required — system-user token with ads_read
//   META_AD_ACCOUNT_ID  required — digits only, e.g. 653083320675538
//   META_API_VERSION    optional — default v26.0
//   LOOKBACK_DAYS       optional — default 190 (covers "last 90 days" + its previous period)

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

await loadDotEnv();

// Any unexpected failure ends up as a readable annotation on the Actions run.
process.on('uncaughtException', (e) => fail(e?.message || String(e)));
process.on('unhandledRejection', (e) => fail(e?.message || String(e)));

const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCOUNT = (process.env.META_AD_ACCOUNT_ID || '').replace(/^act_/, '');
const VERSION = process.env.META_API_VERSION || 'v26.0';
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 190);
const BASE = `https://graph.facebook.com/${VERSION}`;

if (!TOKEN || !ACCOUNT) fail('Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID (add the repository secret, or see .env.example).');

const METRICS = ['spend', 'impressions', 'clicks', 'inline_link_clicks', 'actions', 'action_values',
  'video_thruplay_watched_actions', 'video_continuous_2_sec_watched_actions'];

// ---------- main ----------

const account = await get(`act_${ACCOUNT}`, {
  fields: 'name,currency,timezone_name,account_status',
});
const tz = account.timezone_name || 'UTC';
const until = todayIn(tz);
const since = addDays(until, -(LOOKBACK - 1));
log(`Account: ${account.name} (${account.currency}, ${tz}) — ${since} → ${until}`);

const actionTypes = [];
const actIndex = new Map();
const idx = (t) => {
  if (!actIndex.has(t)) { actIndex.set(t, actionTypes.length); actionTypes.push(t); }
  return actIndex.get(t);
};

// Meta returns 0 spend/impressions/clicks for this account when one synchronous request is
// split by day (time_increment=1), while period totals are correct. So daily data comes from
// async report jobs if they agree with the period totals, else from one request per day.
const MODE = await chooseDailyMode();

// Core rows: [date, id, spend, impressions, clicks, link_clicks, actions{}, values{}]
const campaignRaw = await insights({ level: 'campaign', fields: ['campaign_id', 'campaign_name', 'objective', ...METRICS] });
const adRaw = await insights({ level: 'ad', fields: ['ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', ...METRICS] });
// Breakdowns keep the campaign id so the campaign filter scopes them too.
const ageGenderRaw = await insights({ level: 'campaign', breakdowns: 'age,gender', fields: ['campaign_id', ...METRICS] });
const platformRaw = await insights({ level: 'campaign', breakdowns: 'publisher_platform', fields: ['campaign_id', ...METRICS] });

checkFields(campaignRaw);

const campaigns = {};
for (const r of campaignRaw) {
  campaigns[r.campaign_id] ??= { name: r.campaign_name, objective: r.objective || null, status: null };
}
for (const o of await listObjects('campaigns', 'id,name,objective,effective_status')) {
  if (campaigns[o.id]) Object.assign(campaigns[o.id], { name: o.name, objective: o.objective || campaigns[o.id].objective, status: o.effective_status });
}

const ads = {};
for (const r of adRaw) {
  ads[r.ad_id] ??= {
    name: r.ad_name, adset: r.adset_name, adset_id: r.adset_id, campaign_id: r.campaign_id, status: null, thumb: null,
    link: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${ACCOUNT}&selected_ad_ids=${r.ad_id}`,
  };
}
for (const o of await listObjects('ads', 'id,effective_status,creative{thumbnail_url}')) {
  if (!ads[o.id]) continue;
  ads[o.id].status = o.effective_status || null;
  ads[o.id].thumb = o.creative?.thumbnail_url || null;
}

// What each ad set optimises for decides its "result", the same way Ads Manager's Results column does.
const adsets = {};
const goalVotes = {};
for (const o of await listObjects('adsets', 'id,campaign_id,optimization_goal,promoted_object,effective_status')) {
  const type = resultType(o.optimization_goal, o.promoted_object);
  adsets[o.id] = { goal: o.optimization_goal || null, result_type: type };
  if (!type || !campaigns[o.campaign_id]) continue;
  // A campaign takes the goal most of its ad sets use; active ad sets count double.
  const v = (goalVotes[o.campaign_id] ??= {});
  v[type] = (v[type] || 0) + (o.effective_status === 'ACTIVE' ? 2 : 1);
}
for (const [cid, votes] of Object.entries(goalVotes)) {
  campaigns[cid].result_type = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
}

// Reach isn't additive across days, so fetch it for the preset windows the UI offers —
// for the account and per campaign (campaigns optimising for reach report it as their result).
const PRESETS = ['last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month'];
const reach = {};
const campaignReach = {};
for (const preset of PRESETS) {
  const rows = await optional(`reach ${preset}`, () => getAll(`act_${ACCOUNT}/insights`, { level: 'account', date_preset: preset, fields: 'reach,frequency,impressions' }));
  const r = rows?.[0];
  if (r) reach[preset] = { since: r.date_start, until: r.date_stop, reach: num(r.reach), frequency: num(r.frequency) };
  const byCampaign = await optional(`campaign reach ${preset}`, () => getAll(`act_${ACCOUNT}/insights`, { level: 'campaign', date_preset: preset, fields: 'campaign_id,reach', limit: 500 }));
  if (byCampaign) campaignReach[preset] = Object.fromEntries(byCampaign.map((x) => [x.campaign_id, num(x.reach)]));
}

// Names for custom conversions, so "offsite_conversion.custom.123" reads as something human.
const customConversions = {};
for (const c of (await optional('custom conversions', () => getAll(`act_${ACCOUNT}/customconversions`, { fields: 'id,name', limit: 500 }))) || []) {
  customConversions[c.id] = c.name;
}

const data = {
  meta: {
    account_id: ACCOUNT,
    name: account.name,
    currency: account.currency,
    timezone: tz,
    since,
    until,
    api_version: VERSION,
    generated_at: new Date().toISOString(),
  },
  campaigns,
  adsets,
  ads,
  reach,
  campaign_reach: campaignReach,
  rows: {
    campaign: campaignRaw.map((r) => [r.date_start, r.campaign_id, ...core(r)]),
    ad: adRaw.map((r) => [r.date_start, r.ad_id, ...core(r)]),
    age_gender: ageGenderRaw.map((r) => [r.date_start, r.campaign_id, r.age, r.gender, ...core(r)]),
    platform: platformRaw.map((r) => [r.date_start, r.campaign_id, r.publisher_platform, ...core(r)]),
  },
  action_types: actionTypes,
  custom_conversions: customConversions,
};

await mkdir('data', { recursive: true });
const json = JSON.stringify(data);
await writeFile('data/data.json', json);
log(`Wrote data/data.json (${(json.length / 1024).toFixed(0)} KB): ` +
  `${campaignRaw.length} campaign-days, ${adRaw.length} ad-days, ` +
  `${ageGenderRaw.length} age/gender rows, ${platformRaw.length} platform rows, ` +
  `${Object.keys(campaigns).length} campaigns, ${Object.keys(ads).length} ads.`);

// ---------- helpers ----------

function core(r) {
  return [
    num(r.spend), num(r.impressions), num(r.clicks), num(r.inline_link_clicks),
    packActions(r.actions, { video_thruplay: r.video_thruplay_watched_actions, video_2s: r.video_continuous_2_sec_watched_actions }),
    packActions(r.action_values),
  ];
}

// Video metrics arrive as separate fields; they're stored as extra "action types" so the
// dashboard can treat them like any other result.
function packActions(list, extra = {}) {
  const out = {};
  for (const a of list || []) {
    const v = num(a.value);
    if (v) out[idx(a.action_type)] = round(v);
  }
  for (const [type, l] of Object.entries(extra)) {
    const v = (l || []).reduce((s, a) => s + num(a.value), 0);
    if (v) out[idx(type)] = round(v);
  }
  return out;
}

// Maps an ad set's optimization goal to the metric Ads Manager reports as its result.
function resultType(goal, po = {}) {
  const PIXEL = {
    LEAD: 'offsite_conversion.fb_pixel_lead', COMPLETE_REGISTRATION: 'offsite_conversion.fb_pixel_complete_registration',
    PURCHASE: 'offsite_conversion.fb_pixel_purchase', ADD_TO_CART: 'offsite_conversion.fb_pixel_add_to_cart',
    INITIATED_CHECKOUT: 'offsite_conversion.fb_pixel_initiate_checkout', CONTENT_VIEW: 'offsite_conversion.fb_pixel_view_content',
    SEARCH: 'offsite_conversion.fb_pixel_search', CONTACT: 'contact', SUBMIT_APPLICATION: 'submit_application',
    SCHEDULE: 'schedule', SUBSCRIBE: 'subscribe', START_TRIAL: 'start_trial',
  };
  switch (goal) {
    case 'LEAD_GENERATION': case 'QUALITY_LEAD': return 'lead';
    case 'OFFSITE_CONVERSIONS': case 'VALUE': case 'CONVERSIONS':
      if (po?.custom_conversion_id) return `offsite_conversion.custom.${po.custom_conversion_id}`;
      return PIXEL[po?.custom_event_type] || 'lead';
    case 'THRUPLAY': return 'video_thruplay';
    case 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS': return 'video_2s';
    case 'VIDEO_VIEWS': return 'video_view';
    case 'LINK_CLICKS': return 'link_click';
    case 'LANDING_PAGE_VIEWS': return 'landing_page_view';
    case 'POST_ENGAGEMENT': return 'post_engagement';
    case 'PAGE_LIKES': return 'like';
    case 'CONVERSATIONS': case 'REPLIES': case 'MESSAGING_PURCHASE_CONVERSION': return 'onsite_conversion.messaging_conversation_started_7d';
    case 'APP_INSTALLS': return 'mobile_app_install';
    case 'REACH': return 'reach';
    case 'IMPRESSIONS': case 'AD_RECALL_LIFT': return 'impressions';
    default: return null;
  }
}

function insightParams({ level, fields, breakdowns }) {
  const p = {
    level,
    fields: fields.join(','),
    limit: 500,
    // Match Ads Manager: each ad set's own attribution setting.
    use_unified_attribution_setting: true,
  };
  if (breakdowns) p.breakdowns = breakdowns;
  return p;
}

async function insights(opts) {
  const label = `${opts.level}${opts.breakdowns ? ` × ${opts.breakdowns}` : ''}`;
  const rows = MODE === 'async' ? await asyncInsights(opts, since, until) : await perDayInsights(opts, since, until);
  log(`  ${label}: ${rows.length} rows (${MODE})`);
  return rows;
}

// Daily rows from async report jobs, ~95 days per job.
async function asyncInsights(opts, from, to) {
  const rows = [];
  for (let s = from; s <= to; s = addDays(s, 95)) {
    const e = minDate(addDays(s, 94), to);
    rows.push(...await runJob({ ...insightParams(opts), time_range: JSON.stringify({ since: s, until: e }), time_increment: 1 }));
  }
  return rows;
}

async function runJob(params) {
  const job = await post(`act_${ACCOUNT}/insights`, params);
  const started = Date.now();
  for (;;) {
    const st = await get(job.report_run_id, { fields: 'async_status,async_percent_completion' });
    if (st.async_status === 'Job Completed') break;
    if (/Failed|Skipped/.test(st.async_status || '')) throw new Error(`Async insights job ${st.async_status}`);
    if (Date.now() - started > 20 * 60e3) throw new Error('Async insights job timed out after 20 minutes');
    await new Promise((r) => setTimeout(r, 4000));
  }
  // The read-back needs the field list again, or it only returns Meta's default columns.
  return getAll(`${job.report_run_id}/insights`, { fields: params.fields, limit: 500 });
}

// One request per day (no time_increment) — slower, but returns correct spend.
async function perDayInsights(opts, from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  const out = new Array(days.length);
  let next = 0;
  const worker = async () => {
    while (next < days.length) {
      const i = next++;
      const d = days[i];
      const rows = await getAll(`act_${ACCOUNT}/insights`, { ...insightParams(opts), time_range: JSON.stringify({ since: d, until: d }) });
      out[i] = rows.map((r) => ({ ...r, date_start: r.date_start || d }));
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return out.flat();
}

// Compares daily rows from an async job with Meta's period totals for the last 14 days.
async function chooseDailyMode() {
  if (process.env.DAILY_MODE) return process.env.DAILY_MODE;
  const from = addDays(until, -14), to = addDays(until, -1);
  const opts = { level: 'campaign', fields: ['campaign_id', 'spend', 'impressions', 'inline_link_clicks'] };
  const totals = await getAll(`act_${ACCOUNT}/insights`, { ...insightParams(opts), time_range: JSON.stringify({ since: from, until: to }) });
  let daily;
  try { daily = await asyncInsights(opts, from, to); } catch (err) {
    log(`Daily mode: per-day (async jobs unavailable: ${err.message})`);
    return 'per-day';
  }
  const sum = (rows, f) => rows.reduce((s, r) => s + num(r[f]), 0);
  const checks = ['spend', 'impressions', 'inline_link_clicks'].map((f) => {
    const a = sum(daily, f), b = sum(totals, f);
    return [f, a === b || (b > 0 && Math.abs(a - b) / b < 0.02)];
  });
  const ok = checks.every(([, v]) => v);
  const msg = `Daily mode: ${ok ? 'async' : 'per-day'} — async daily vs period totals: ${checks.map(([f, v]) => `${f} ${v ? 'match' : 'MISMATCH'}`).join(', ')}`;
  log(msg);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Daily mode::${msg}`);
  return ok ? 'async' : 'per-day';
}

// Names/status/thumbnails are nice-to-have: if the list call fails, keep the names from insights.
// Archived objects are only listed when asked for explicitly, so try that first.
async function listObjects(edge, fields) {
  const statuses = {
    campaigns: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES'],
    adsets: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED'],
    ads: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
      'DISAPPROVED', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO'],
  }[edge];
  const base = { fields, limit: 200 };
  const all = await optional(`${edge} (incl. archived)`, () =>
    getAll(`act_${ACCOUNT}/${edge}`, { ...base, effective_status: JSON.stringify(statuses) }));
  return all ?? (await optional(edge, () => getAll(`act_${ACCOUNT}/${edge}`, base))) ?? [];
}

async function optional(label, fn) {
  try { return await fn(); } catch (err) { log(`  (${label} skipped: ${err.message})`); return null; }
}

async function getAll(path, params) {
  const out = [];
  let res = await get(path, params);
  out.push(...(res.data || []));
  while (res.paging?.next) {
    res = await request(res.paging.next);
    out.push(...(res.data || []));
  }
  return out;
}

function get(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return request(url.toString());
}

function post(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return request(url.toString(), 1, 'POST');
}

async function request(url, attempt = 1, method = 'GET') {
  const u = new URL(url);
  u.searchParams.set('access_token', TOKEN);
  const res = await fetch(u, { method });
  const body = await res.json().catch(() => ({}));
  if (res.ok && !body.error) return body;

  const e = body.error || {};
  const retryable = [1, 2, 4, 17, 341, 613, 80000, 80004].includes(e.code) || res.status >= 500;
  if (retryable && attempt < 6) {
    const wait = Math.min(60, 2 ** attempt * 2);
    log(`  API ${e.code ?? res.status} (${e.message || res.statusText}) — retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return request(url, attempt + 1, method);
  }
  const where = u.pathname.replace(/^\/v[\d.]+\//, '');
  throw new Error(`Meta API error ${e.code ?? res.status}${e.error_subcode ? `/${e.error_subcode}` : ''} on ${where || '/'}: ${e.message || res.statusText}${hint(e)}`);
}

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(d, n) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function minDate(a, b) { return a < b ? a : b; }
function num(v) { const n = Number(typeof v === 'string' ? v.replace(/,/g, '') : v); return Number.isFinite(n) ? n : 0; }
function round(v) { return Math.round(v * 100) / 100; }
function log(m) { console.log(m); }

// Reports which metric fields Meta actually returned and whether they parse — names and
// formats only (digits masked), since Actions logs on a public repo are readable by anyone.
function checkFields(rows) {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  const report = ['spend', 'impressions', 'clicks', 'inline_link_clicks'].map((f) => {
    const present = rows.filter((r) => r[f] != null);
    const parsed = present.filter((r) => num(r[f]) !== 0);
    const shape = present.length ? String(present[0][f]).replace(/\d/g, 'd') : '-';
    return `${f}: present ${present.length}/${rows.length}, non-zero ${parsed.length}, format "${shape}"`;
  });
  const msg = `Fields returned: ${[...keys].sort().join(', ')} || ${report.join(' || ')}`;
  log(msg);
  const bad = rows.length && rows.every((r) => !num(r.spend));
  if (process.env.GITHUB_ACTIONS) console.log(`::${bad ? 'warning' : 'notice'} title=Field check::${msg}`);
}

// Prints a GitHub Actions error annotation (visible on the run page) and exits.
function fail(msg) {
  console.log(process.env.GITHUB_ACTIONS ? `::error title=Meta fetch failed::${msg}` : msg);
  process.exit(1);
}
function hint(e) {
  if (e.code === 190) return ' → the token is invalid or expired; generate a new system-user token.';
  if (e.code === 200 || e.code === 10 || e.code === 100 && /permission|access/i.test(e.message || '')) return ' → the system user needs "View performance" on the ad account and the token needs ads_read.';
  if (e.code === 2635) return ' → set META_API_VERSION to a newer Graph API version.';
  return '';
}

async function loadDotEnv() {
  if (!existsSync('.env')) return;
  for (const line of (await readFile('.env', 'utf8')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
