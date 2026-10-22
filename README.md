# Career180 · Meta Ads dashboard

A live dashboard for the Career180 Meta ad account (`act_653083320675538`), rebuilt every morning by GitHub Actions and hosted on GitHub Pages.

**How it works.** Every morning at 02:37 & 03:37 UTC, `.github/workflows/refresh.yml` does four things:

1. `scripts/fetch-meta.mjs` pulls up to 190 days of daily insights from the Meta Marketing API, at campaign and ad level, plus age/gender and placement breakdowns.
2. `scripts/build.mjs` puts that data into `site/index.html` and writes one self-contained `dist/index.html`.
3. If a `DASHBOARD_PASSWORD` secret is set, the page is encrypted with [StatiCrypt](https://github.com/robinmoisson/staticrypt), so viewers need the team password.
4. The page is deployed to GitHub Pages.

The ad data is never committed to the repository. It only exists inside the deployed page, and that page is encrypted when a password is set.

## One-time setup

### 1. Meta access token (system user, never expires)

1. Open [Business Settings → Users → System users](https://business.facebook.com/settings/system-users) in the Business Manager that owns the ad account. Add a system user, for example `dashboard-bot`, with the **Employee** role.
2. **Assign assets** → Ad accounts → `653083320675538` → turn on **View performance**.
3. Check that the app `1116050211166388` is connected to the same business (**Business Settings → Accounts → Apps**) and has the Marketing API use case.
4. On the system user, click **Generate new token**. Choose the app, set expiry to **Never**, and select the `ads_read` permission. Copy the token.

### 2. GitHub secrets

In **Repo → Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `META_ACCESS_TOKEN` | the token from step 1 |
| `DASHBOARD_PASSWORD` | the password the team will use (optional; without it the page is public) |

### 3. GitHub Pages

Go to **Repo → Settings → Pages → Build and deployment** and set Source to **GitHub Actions**. Then go to **Actions → Refresh dashboard → Run workflow** for the first deploy.

## Day to day

- **Refresh now:** go to Actions → Refresh dashboard → Run workflow (it takes about 1–2 minutes).
- **Share a view:** the URL hash keeps the selected range, campaign and result type. Copy the address bar to share that exact view.
- **Change the password:** update the `DASHBOARD_PASSWORD` secret, then re-run the workflow.
- **If the refresh fails:** the dashboard shows a "Data from … — refresh may have failed" badge after 36 hours. Check the Actions log. The usual cause is a revoked token or someone removing the system user's access to the ad account.

## Local development

```bash
cp .env.example .env        # paste a token into .env
npm run refresh             # fetch + build → dist/index.html
npm run sample              # or: build with fake data, no token needed
```

## Notes on the numbers

- Results follow each ad set's own attribution setting, so they match Ads Manager.
- The "Count as result" picker switches between conversion types: leads, registrations, purchases, messaging conversations, custom conversions, and so on.
- Reach and frequency only show for preset ranges across all campaigns. Unique reach can't be added up across days, so it is fetched separately for each preset.
- The most recent 1–3 days can still change a little as Meta attributes late conversions.
