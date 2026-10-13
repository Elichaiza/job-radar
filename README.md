# Job Radar

Finds computer-science jobs in Israel that ask for 0-2 years of experience, straight from company job boards.

- **Site:** `docs/` (GitHub Pages). Loads the ready-made `docs/data/jobs.json`, so it opens instantly.
- **Collector:** `scripts/collect.mjs`, run by GitHub Actions every 4 hours (`.github/workflows/collect.yml`).
- **Companies:** `data/companies.json`. Each entry is `{ name, ats, slug }`, where `ats` is one of
  `greenhouse`, `lever`, `ashby`, `smartrecruiters`, `comeet` (needs `token`), `workday`, `amazon`.
- **Rules:** `docs/lib/classify.js` decides what counts as a tech role, the category, and the experience level.
  The same file runs in the collector and in the browser.
- **Accounts:** `docs/accounts.js`, on a free Firebase project whose web config goes in `docs/config.js`.
  Users sign up with email and password; each user's marks ("applied" / "hidden") live in Firestore under
  `users/<uid>`, protected by `firestore.rules` (paste that file into the Firebase console).
  While `docs/config.js` is empty the site has no accounts and the marks are stored in the private repo
  `job-radar-state`, in `state.json`, using a GitHub token.

## Running locally

```
node scripts/collect.mjs                      # refresh docs/data/jobs.json
node scripts/discover.mjs "Company Name"      # find which job board a company uses
python -m http.server 8765 --directory docs   # open http://127.0.0.1:8765
```

## Adding a company

Type its name in the site's company search. If the board is found right away the company is added to
`data/companies.json`; otherwise the name is queued in `data/requests.json` and the next collector run
looks for it by crawling the company's careers page.

`data/linkedin-companies.json` (LinkedIn ids of Israeli tech companies) is also derived from the Israeli Tech Map.
