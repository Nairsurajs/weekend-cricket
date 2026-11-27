# Deploying Weekend Cricket on OpenShift (Developer Sandbox)

Everything runs in one project and is reached on one HTTPS address:

| Piece | What it is | Where it lives |
|---|---|---|
| `cricket` | The web app (Httpd, built from this repo's root) | Route `/` |
| `api` | Node.js API (built from `api/` with its Dockerfile) | Route `/api` on the same host |
| `postgresql` | PostgreSQL 16 with a 1 GiB persistent volume | Internal only |
| Monitoring | ServiceMonitor + 4 alert rules | Observe → Metrics / Alerting |

## First deploy (or after a sandbox renewal)

1. **Web app**: + → Import from Git → `https://github.com/Nairsurajs/weekend-cricket` → Builder Image **Httpd**,
   application `weekend-cricket`, name `cricket`, resource type **Deployment**, secure route **Edge / Redirect**.
2. **Secret** (never commit this): Workloads → Secrets → Create → Key/value secret
   - Name: `cricket-secrets`
   - Key `SCORER_PIN` = the PIN your scorers will use
   - Key `DB_PASSWORD` = a long random password (you never need to type it again)
3. **Backend**: open `openshift/cricket-backend.yaml`. If your app address changed, update the Route `host`
   to the `cricket` route's host. Then + → Import YAML → paste → Create. The `api` build takes about 2 minutes.
4. **Monitoring**: + → Import YAML → paste `openshift/cricket-monitoring.yaml` → Create.
5. **Health checks on the web app**: Topology → `cricket` → Actions → Add Health Checks →
   Readiness and Liveness, both HTTP GET `/` port 8080.

## After changing the code on GitHub

- Web app changed (`index.html`, `sw.js`): Builds → BuildConfigs → `cricket` → Actions → **Start build**.
- API changed (`api/`): Builds → BuildConfigs → `api` → Actions → **Start build**.

## Monitoring

Observe → Metrics, useful queries:

- Requests per second: `sum(rate(cricket_api_http_requests_total[5m])) by (route)`
- 95th percentile latency: `histogram_quantile(0.95, sum(rate(cricket_api_http_request_duration_seconds_bucket[5m])) by (le))`
- Database reachable: `cricket_db_up`
- Matches stored: `cricket_matches`
- Ball-by-ball saves: `rate(cricket_match_saves_total[5m])`

Observe → Alerting shows `CricketApiDown`, `CricketDatabaseDown`, `CricketApiErrors` and `CricketAppDown`.

## Before the 30-day sandbox ends

Open the app → **History** → **Download backup**. After re-deploying on the new sandbox,
History → **Restore backup** (needs the scorer PIN).
