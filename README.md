# Hangar status page

Public, externally-hosted status page for the
[Hangar e-commerce platform](https://github.com/hangar-ecommerce/hangar). Lives
in its own public repository so it stays up even when Hangar is down, and
because public repositories get unlimited free GitHub Actions minutes — the
probe workflow runs every 5 minutes at zero cost.

- Live URL: <https://status.shop.kopaxgroup.com>
- Probe workflow: [`.github/workflows/probe.yml`](.github/workflows/probe.yml)
- Probe logic: [`scripts/probe.mjs`](scripts/probe.mjs)
- Data files (committed by the workflow):
  - [`status.json`](status.json) — current snapshot consumed by the page
  - [`history.jsonl`](history.jsonl) — append-only log used to render the
    30-day uptime bar chart

## How it works

```text
                +--------------------------+
GitHub Actions  |  probe.yml (cron */5)    |
cron */5 min -> |  scripts/probe.mjs       |
                |    fetch each component  |
                |    classify status       |
                |    update status.json    |
                |    append history.jsonl  |
                |    git commit + push     |
                +-----------+--------------+
                            |
                            v
                +--------------------------+
                |  GitHub Pages (main, /)  |
                |  index.html + app.js     |
                |  fetches status.json     |
                |  + history.jsonl every   |
                |  30s in the browser      |
                +--------------------------+
```

The page is plain HTML/CSS/JS, no build step. Open `index.html` in a browser
to preview locally.

## Local preview

```bash
# Any static server will do. Two zero-install options:
python3 -m http.server 4173
# or
npx --yes http-server -p 4173 -c-1
```

Then visit <http://localhost:4173>.

## Configuring secrets

The probe workflow reads the URLs to probe from repository secrets. Set them
under **Settings → Secrets and variables → Actions**:

| Secret                   | Example value                              | Probe                          |
| ------------------------ | ------------------------------------------ | ------------------------------ |
| `STAGING_API_URL`        | `https://api.staging.shop.kopaxgroup.com`  | `GET <url>/v1/health` JSON     |
| `PROD_API_URL`           | `https://api.shop.kopaxgroup.com`          | `GET <url>/v1/health` JSON     |
| `STAGING_STOREFRONT_URL` | `https://staging.shop.kopaxgroup.com`      | `HEAD <url>` 200               |
| `PROD_STOREFRONT_URL`    | `https://shop.kopaxgroup.com`              | `HEAD <url>` 200               |
| `STAGING_BACKOFFICE_URL` | `https://admin.staging.shop.kopaxgroup.com`| `HEAD <url>` 200               |
| `PROD_BACKOFFICE_URL`    | `https://admin.shop.kopaxgroup.com`        | `HEAD <url>` 200               |

A missing secret marks the component as `unknown` (rather than failing the
workflow) so the page degrades gracefully while the platform is being
bootstrapped.

### Classification rules

| Condition                                                         | Reported status |
| ----------------------------------------------------------------- | --------------- |
| HTTP 200 + (for health) `body.status === "ok"`                    | `operational`   |
| HTTP 200 but body parse fails / `status` not `ok`                 | `degraded`      |
| Non-200, non-5xx response                                         | `degraded`      |
| HTTP 5xx, network error, or 10 s timeout                          | `down`          |

## Enabling GitHub Pages + custom domain

1. **Settings → Pages**: source = `main` branch, root (`/`). Save. GitHub
   should pick up the existing `CNAME` file with `status.shop.kopaxgroup.com`.
2. In Route53, in the `shop.kopaxgroup.com` hosted zone (staging account
   `hangar`, 576090749529), create a `CNAME` record:
   - Name: `status`
   - Type: `CNAME`
   - Value: `hangar-ecommerce.github.io`
   - TTL: 300
3. Back in **Settings → Pages**, tick **Enforce HTTPS**. The TLS cert
   provisions automatically within a few minutes.
4. CLI alternative for step 1:
   ```bash
   gh api -X POST /repos/hangar-ecommerce/status-page/pages \
     -f source[branch]=main -f source[path]=/
   ```

## Why a separate public repo?

- **Stays up when Hangar is down.** No shared AWS dependency.
- **Free CI.** Public repos get unlimited GitHub Actions minutes, so the
  5-minute cron is free forever.
- **Auditable.** Anyone can read the probe code and the history — credibility
  for incident postmortems.
- **No build step.** Vanilla HTML/CSS/JS, served straight from `main`.

## Accessibility

The page targets **WCAG 2.2 AA**:

- semantic HTML (`<table>`, `<section>`, `<header>`, `<main>`, `<footer>`),
- visible focus rings (`:focus-visible`) and a skip link,
- status never relies on color alone — every dot is paired with an icon
  (`OK`, `!`, `X`, `?`) and a text label,
- `aria-live="polite"` region announces status transitions,
- history bars are real `<button>` elements with `aria-label` describing the
  timestamp and status.

## License

MIT — see [`LICENSE`](LICENSE).
