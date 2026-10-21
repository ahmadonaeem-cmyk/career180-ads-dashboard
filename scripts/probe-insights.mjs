// Runs the same "last 7 days" insights request several ways to find which parameter makes
// Meta return zero spend/impressions. In GitHub Actions it reports only zero / non-zero
// (logs on a public repo are readable by anyone); locally it prints the values.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

if (existsSync('.env')) {
  for (const line of (await readFile('.env', 'utf8')).split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const TOKEN = process.env.META_ACCESS_TOKEN;
const ACCOUNT = (process.env.META_AD_ACCOUNT_ID || '653083320675538').replace(/^act_/, '');
const CI = !!process.env.GITHUB_ACTIONS;
const FIELDS = 'spend,impressions,clicks,inline_link_clicks';

const yday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const wk = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
const range = JSON.stringify({ since: wk, until: yday });

const days = [...Array(7)].map((_, i) => new Date(Date.now() - (i + 1) * 864e5).toISOString().slice(0, 10)).reverse();
const twoWk = JSON.stringify({ since: new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), until: yday });
const variants = {
  'D range (control)': { time_range: range },
  'E range+daily (broken)': { time_range: range, time_increment: '1' },
  'J time_ranges per day': { time_ranges: JSON.stringify(days.map((d) => ({ since: d, until: d }))) },
  'K weekly increment': { time_range: twoWk, time_increment: '7' },
  'L monthly increment': { date_preset: 'last_90d', time_increment: 'monthly' },
  'N campaign time_ranges per day': { level: 'campaign', time_ranges: JSON.stringify(days.map((d) => ({ since: d, until: d }))) },
  'O campaign range total': { level: 'campaign', time_range: range },
  'P campaign range total age,gender': { level: 'campaign', time_range: range, breakdowns: 'age,gender' },
  'Q single day range': { time_range: JSON.stringify({ since: yday, until: yday }) },
  'R ad range total': { level: 'ad', time_range: range },
};

const lines = [];
const report = (name, rows) => {
  const sum = (f) => rows.reduce((s, r) => s + Number(r[f] || 0), 0);
  const out = FIELDS.split(',').map((f) => `${f}=${CI ? (sum(f) ? 'yes' : 'ZERO') : sum(f)}`).join(' ');
  lines.push(`${name}: rows=${rows.length} ${out}`);
};
const api = async (path, params = {}, method = 'GET') => {
  const u = new URL(`https://graph.facebook.com/v26.0/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', TOKEN);
  return (await fetch(u, { method })).json();
};

for (const [name, params] of Object.entries(variants)) {
  const body = await api(`act_${ACCOUNT}/insights`, { fields: FIELDS, limit: '500', ...params });
  if (body.error) { lines.push(`${name}: error ${body.error.code} ${body.error.message}`); continue; }
  report(name, body.data || []);
}

// M: asynchronous report job with daily increment
try {
  const job = await api(`act_${ACCOUNT}/insights`, { fields: FIELDS, level: 'campaign', time_range: range, time_increment: '1' }, 'POST');
  if (job.error) throw new Error(`${job.error.code} ${job.error.message}`);
  let st = {};
  for (let i = 0; i < 40; i++) {
    st = await api(job.report_run_id, { fields: 'async_status,async_percent_completion' });
    if (st.async_status === 'Job Completed' || /Fail|Skipped/.test(st.async_status || '')) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (st.async_status !== 'Job Completed') throw new Error(`status ${st.async_status}`);
  const res = await api(`${job.report_run_id}/insights`, { limit: '500' });
  report('M async campaign daily', res.data || []);
} catch (e) { lines.push(`M async campaign daily: error ${e.message}`); }

for (const l of lines) console.log(l);
if (CI) console.log(`::notice title=Insights probe::${lines.join(' || ')}`);
