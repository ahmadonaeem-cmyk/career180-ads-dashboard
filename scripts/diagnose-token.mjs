// Explains what a Meta token can and can't reach. Never prints the token.
// Usage: put META_ACCESS_TOKEN in .env, then `node scripts/diagnose-token.mjs`

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
const BASE = `https://graph.facebook.com/${process.env.META_API_VERSION || 'v24.0'}`;
if (!TOKEN) { console.log('No META_ACCESS_TOKEN in .env'); process.exit(1); }

async function get(path, params = {}) {
  const u = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('access_token', TOKEN);
  const r = await fetch(u);
  return r.json();
}
const show = (label, v) => console.log(`${label.padEnd(22)} ${v}`);

const dbg = (await get('debug_token', { input_token: TOKEN })).data || {};
show('Valid', dbg.is_valid);
show('Type', dbg.type);
show('App', `${dbg.application || '?'} (${dbg.app_id || '?'})`);
show('Expires', dbg.expires_at === 0 ? 'never' : dbg.expires_at ? new Date(dbg.expires_at * 1000).toISOString() : '?');
show('Scopes', (dbg.scopes || []).join(', ') || '(none)');
const gran = (dbg.granular_scopes || []).find((g) => g.scope === 'ads_read' || g.scope === 'ads_management');
if (gran) show(`${gran.scope} limited to`, gran.target_ids ? gran.target_ids.join(', ') : 'all assets');
if (dbg.error) show('Debug error', dbg.error.message);

const me = await get('me', { fields: 'id,name' });
show('Token belongs to', me.error ? `error: ${me.error.message}` : `${me.name} (${me.id})`);

const accts = await get('me/adaccounts', { fields: 'account_id,name,business{name}', limit: '200' });
if (accts.error) show('Ad accounts', `error: ${accts.error.message}`);
else {
  show('Ad accounts visible', accts.data.length);
  for (const a of accts.data) console.log(`   ${a.account_id === ACCOUNT ? '→' : ' '} act_${a.account_id}  ${a.name}${a.business ? `  [${a.business.name}]` : ''}`);
}

const acct = await get(`act_${ACCOUNT}`, { fields: 'name,business{id,name},owner' });
show(`act_${ACCOUNT}`, acct.error ? `error ${acct.error.code}: ${acct.error.message}` : `${acct.name}, business: ${acct.business ? `${acct.business.name} (${acct.business.id})` : 'none'}`);

const ins = await get(`act_${ACCOUNT}/insights`, { date_preset: 'last_7d', fields: 'spend' });
show('Insights test', ins.error ? `error ${ins.error.code}: ${ins.error.message}` : `OK — last 7d spend ${ins.data?.[0]?.spend ?? 0}`);
