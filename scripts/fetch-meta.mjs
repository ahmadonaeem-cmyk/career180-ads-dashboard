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
const CHUNK_DAYS = 30;
const BASE = `https://graph.facebook.com/${VERSION}`;

if (!TOKEN || !ACCOUNT) fail('Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID (add the repository secret, or see .env.example).');

const METRICS = ['spend', 'impressions', 'clicks', 'inline_link_clicks', 'actions', 'action_values'];

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

// Core rows: [date, id, spend, impressions, clicks, link_clicks, actions{}, values{}]
const campaignRaw = await insights({ level: 'campaign', fields: ['campaign_id', 'campaign_name', 'objective', ...METRICS] });
const adRaw = await insights({ level: 'ad', fields: ['ad_id', 'ad_name', 'adset_name', 'campaign_id', ...METRICS] });
// Breakdowns keep the campaign id so the campaign filter scopes them too.
const ageGenderRaw = await insights({ level: 'campaign', breakdowns: 'age,gender', fields: ['campaign_id', ...METRICS] });
const platformRaw = await insights({ level: 'campaign', breakdowns: 'publisher_platform', fields: ['campaign_id', ...METRICS] });

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
    name: r.ad_name, adset: r.adset_name, campaign_id: r.campaign_id, status: null, thumb: null,
    link: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${ACCOUNT}&selected_ad_ids=${r.ad_id}`,
  };
}
for (const o of await listObjects('ads', 'id,effective_status,creative{thumbnail_url}')) {
  if (!ads[o.id]) continue;
  ads[o.id].status = o.effective_status || null;
  ads[o.id].thumb = o.creative?.thumbnail_url || null;
}

// Reach isn't additive across days, so fetch it for the preset windows the UI offers.
const reach = {};
for (const preset of ['last_7d', 'last_14d', 'last_30d', 'last_90d', 'this_month', 'last_month']) {
  const rows = await optional(`reach ${preset}`, () => getAll(`act_${ACCOUNT}/insights`, { level: 'account', date_preset: preset, fields: 'reach,frequency,impressions' }));
  const r = rows?.[0];
  if (r) reach[preset] = { since: r.date_start, until: r.date_stop, reach: num(r.reach), frequency: num(r.frequency) };
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
  ads,
  reach,
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
    packActions(r.actions), packActions(r.action_values),
  ];
}

function packActions(list) {
  const out = {};
  for (const a of list || []) {
    const v = num(a.value);
    if (v) out[idx(a.action_type)] = round(v);
  }
  return out;
}

async function insights({ level, fields, breakdowns }) {
  const rows = [];
  for (let s = since; s <= until; s = addDays(s, CHUNK_DAYS)) {
    const e = minDate(addDays(s, CHUNK_DAYS - 1), until);
    const params = {
      level,
      fields: fields.join(','),
      time_increment: 1,
      time_range: JSON.stringify({ since: s, until: e }),
      limit: 500,
      // Match Ads Manager: each ad set's own attribution setting.
      use_unified_attribution_setting: true,
    };
    if (breakdowns) params.breakdowns = breakdowns;
    const chunk = await getAll(`act_${ACCOUNT}/insights`, params);
    rows.push(...chunk);
    log(`  ${level}${breakdowns ? ` × ${breakdowns}` : ''} ${s}…${e}: ${chunk.length} rows`);
  }
  return rows;
}

// Names/status/thumbnails are nice-to-have: if the list call fails, keep the names from insights.
// Archived objects are only listed when asked for explicitly, so try that first.
async function listObjects(edge, fields) {
  const statuses = ['ACTIVE', 'PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
    'DISAPPROVED', 'PENDING_REVIEW', 'PREAPPROVED', 'PENDING_BILLING_INFO'];
  const base = { fields, limit: 200 };
  const all = await optional(`${edge} (incl. archived)`, () =>
    getAll(`act_${ACCOUNT}/${edge}`, { ...base, effective_status: JSON.stringify(edge === 'ads' ? statuses : statuses.filter((x) => !/_PAUSED$|APPROV|REVIEW/.test(x))) }));
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

async function request(url, attempt = 1) {
  const u = new URL(url);
  u.searchParams.set('access_token', TOKEN);
  const res = await fetch(u);
  const body = await res.json().catch(() => ({}));
  if (res.ok && !body.error) return body;

  const e = body.error || {};
  const retryable = [1, 2, 4, 17, 341, 613, 80000, 80004].includes(e.code) || res.status >= 500;
  if (retryable && attempt < 6) {
    const wait = Math.min(60, 2 ** attempt * 2);
    log(`  API ${e.code ?? res.status} (${e.message || res.statusText}) — retrying in ${wait}s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return request(url, attempt + 1);
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
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round(v) { return Math.round(v * 100) / 100; }
function log(m) { console.log(m); }

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
