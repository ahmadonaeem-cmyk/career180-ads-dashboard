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

const variants = {
  'A preset': { date_preset: 'last_7d' },
  'B preset+unified': { date_preset: 'last_7d', use_unified_attribution_setting: 'true' },
  'C preset+daily': { date_preset: 'last_7d', time_increment: '1' },
  'D range': { time_range: range },
  'E range+daily': { time_range: range, time_increment: '1' },
  'F range+daily+unified': { time_range: range, time_increment: '1', use_unified_attribution_setting: 'true' },
  'G campaign+range+daily+unified (current)': { level: 'campaign', time_range: range, time_increment: '1', use_unified_attribution_setting: 'true' },
  'H campaign+range+daily': { level: 'campaign', time_range: range, time_increment: '1' },
  'I campaign+range+daily+windows': { level: 'campaign', time_range: range, time_increment: '1', action_attribution_windows: '["7d_click","1d_view"]' },
};

const lines = [];
for (const version of ['v26.0', 'v24.0']) {
  for (const [name, params] of Object.entries(variants)) {
    const u = new URL(`https://graph.facebook.com/${version}/act_${ACCOUNT}/insights`);
    for (const [k, v] of Object.entries({ fields: FIELDS, limit: '500', ...params })) u.searchParams.set(k, v);
    u.searchParams.set('access_token', TOKEN);
    const body = await (await fetch(u)).json();
    if (body.error) { lines.push(`${version} ${name}: error ${body.error.code} ${body.error.message}`); continue; }
    const sum = (f) => (body.data || []).reduce((s, r) => s + Number(r[f] || 0), 0);
    const out = FIELDS.split(',').map((f) => `${f}=${CI ? (sum(f) ? 'yes' : 'ZERO') : sum(f)}`).join(' ');
    lines.push(`${version} ${name}: rows=${(body.data || []).length} ${out}`);
  }
}
for (const l of lines) console.log(l);
if (CI) console.log(`::notice title=Insights probe::${lines.join(' || ')}`);
