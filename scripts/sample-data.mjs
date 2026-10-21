// Writes data/sample.json with realistic fake numbers, for previewing the UI without a token.

import { mkdir, writeFile } from 'node:fs/promises';

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (v, p = 0.35) => v * (1 - p + rand() * 2 * p);

const DAYS = 180;
const until = new Date(); until.setUTCHours(0, 0, 0, 0);
const dates = [...Array(DAYS)].map((_, i) => {
  const d = new Date(until); d.setUTCDate(d.getUTCDate() - (DAYS - 1 - i)); return d.toISOString().slice(0, 10);
});

const action_types = ['link_click', 'landing_page_view', 'lead', 'onsite_conversion.lead_grouped',
  'complete_registration', 'onsite_conversion.messaging_conversation_started_7d', 'video_view', 'post_engagement', 'purchase', 'video_thruplay'];
const A = Object.fromEntries(action_types.map((t, i) => [t, i]));

const campaigns = {
  c1: { name: 'Leads | Data Analysis Diploma | Oct', objective: 'OUTCOME_LEADS', status: 'ACTIVE', budget: 2600, cpl: 95, start: 0 },
  c2: { name: 'Leads | HR Diploma | Instant Form', objective: 'OUTCOME_LEADS', status: 'ACTIVE', budget: 1800, cpl: 70, start: 20 },
  c3: { name: 'Sales | Career Shift Bootcamp', objective: 'OUTCOME_SALES', status: 'ACTIVE', budget: 2200, cpl: 160, start: 60 },
  c4: { name: 'Messages | Free Career Consultation', objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED', budget: 900, cpl: 35, start: 0, end: 150 },
  c5: { name: 'Retargeting | Website Visitors 30d', objective: 'OUTCOME_LEADS', status: 'ACTIVE', budget: 700, cpl: 55, start: 40 },
  c6: { name: 'Awareness | Brand Video Q3', objective: 'OUTCOME_AWARENESS', status: 'PAUSED', budget: 1200, cpl: 0, start: 10, end: 110 },
};
const ads = {};
let n = 0;
for (const [cid, c] of Object.entries(campaigns)) {
  for (const v of ['Video testimonial', 'Carousel – modules', 'Static – salary hook', 'Reel – instructor']) {
    if (rand() < 0.2) continue;
    ads[`a${++n}`] = { name: `${v} ${n}`, adset: `${c.name.split('|')[1].trim()} – Broad EG`, campaign_id: cid, status: c.status, thumb: null, link: null, w: 0.4 + rand() };
  }
}

const rows = { campaign: [], ad: [], age_gender: [], platform: [] };
const AGES = [['18-24', 0.3], ['25-34', 0.42], ['35-44', 0.18], ['45-54', 0.07], ['55-64', 0.03]];
const GENDERS = [['female', 0.52], ['male', 0.45], ['unknown', 0.03]];
const PLATFORMS = [['facebook', 0.55], ['instagram', 0.4], ['audience_network', 0.03], ['messenger', 0.02]];

dates.forEach((date, di) => {
  const growth = 0.75 + (di / DAYS) * 0.5;
  for (const [cid, c] of Object.entries(campaigns)) {
    if (di < c.start || (c.end && di > c.end)) continue;
    const spend = jitter(c.budget * growth);
    const impr = spend / jitter(c.objective === 'OUTCOME_AWARENESS' ? 22 : 48) * 1000;
    const link = impr * jitter(c.objective === 'OUTCOME_AWARENESS' ? 0.004 : 0.011);
    const clicks = link * jitter(1.6, 0.1);
    const results = c.cpl ? spend / jitter(c.cpl) : 0;
    const acts = { [A.link_click]: r(link), [A.landing_page_view]: r(link * 0.72) };
    const vals = {};
    if (c.objective === 'OUTCOME_LEADS') { acts[A.lead] = r(results); acts[A['onsite_conversion.lead_grouped']] = r(results * 0.6); }
    if (c.objective === 'OUTCOME_SALES') { acts[A.complete_registration] = r(results * 2.2); acts[A.purchase] = r(results * 0.25); vals[A.purchase] = r(results * 0.25 * 4500); }
    if (c.objective === 'OUTCOME_ENGAGEMENT') acts[A['onsite_conversion.messaging_conversation_started_7d']] = r(results);
    if (c.objective === 'OUTCOME_AWARENESS') { acts[A.video_view] = r(impr * 0.3); acts[A.video_thruplay] = r(impr * 0.08); }
    acts[A.post_engagement] = r(impr * 0.03);
    rows.campaign.push([date, cid, +spend.toFixed(2), r(impr), r(clicks), r(link), acts, vals]);

    const cads = Object.entries(ads).filter(([, a]) => a.campaign_id === cid);
    const tw = cads.reduce((s, [, a]) => s + a.w, 0);
    for (const [aid, a] of cads) {
      const f = a.w / tw;
      rows.ad.push([date, aid, +(spend * f).toFixed(2), r(impr * f), r(clicks * f), r(link * f), scale(acts, f * jitter(1, 0.3)), scale(vals, f)]);
    }
    for (const [age, af] of AGES) for (const [g, gf] of GENDERS) {
      const f = af * gf;
      rows.age_gender.push([date, cid, age, g, +(spend * f).toFixed(2), r(impr * f), r(clicks * f), r(link * f), scale(acts, f * jitter(1, 0.4)), scale(vals, f)]);
    }
    for (const [p, pf] of PLATFORMS) {
      rows.platform.push([date, cid, p, +(spend * pf).toFixed(2), r(impr * pf), r(clicks * pf), r(link * pf), scale(acts, pf * jitter(1, 0.3)), scale(vals, pf)]);
    }
  }
});

function r(v) { return Math.round(v); }
function scale(o, f) { const out = {}; for (const k in o) { const v = Math.round(o[k] * f); if (v) out[k] = v; } return out; }

const GOAL_TYPE = { OUTCOME_LEADS: 'lead', OUTCOME_SALES: 'purchase', OUTCOME_ENGAGEMENT: 'onsite_conversion.messaging_conversation_started_7d', OUTCOME_AWARENESS: 'video_thruplay' };
const adsets = {};
for (const [cid, c] of Object.entries(campaigns)) { c.result_type = GOAL_TYPE[c.objective]; adsets['s_' + cid] = { goal: null, result_type: c.result_type }; }
for (const a of Object.values(ads)) a.adset_id = 's_' + a.campaign_id;
for (const c of Object.values(campaigns)) { delete c.budget; delete c.cpl; delete c.start; delete c.end; }
for (const a of Object.values(ads)) delete a.w;

const last = dates.at(-1);
const reach = {
  last_7d: { reach: 182000, frequency: 1.84 }, last_14d: { reach: 301000, frequency: 2.12 },
  last_30d: { reach: 512000, frequency: 2.61 }, last_90d: { reach: 1104000, frequency: 3.4 },
};

const data = {
  meta: { account_id: '653083320675538', name: 'Career180 (SAMPLE DATA)', currency: 'EGP', timezone: 'Africa/Cairo',
    since: dates[0], until: last, api_version: 'v24.0', generated_at: new Date().toISOString(), sample: true },
  campaigns, adsets, ads, reach, rows, action_types,
};
await mkdir('data', { recursive: true });
await writeFile('data/sample.json', JSON.stringify(data));
console.log(`Wrote data/sample.json (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`);
