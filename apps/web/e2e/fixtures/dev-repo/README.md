Fixtures for `e2e/dev.spec.ts`.

- `shop-v1.zip` — a tiny repository laid out like GitHub's "Download ZIP" (everything under
  `shop-main/`): `src/auth.ts` (`createSession`, `hashToken`), `src/server.ts` (two routes and a
  handler), `api/report.py` and a README. Scans to 6 symbols in 3 code files.
- `shop-v2.zip` — the same with one signature changed: `createSession(userId, ttlMs)` gained a
  `scope: string[]` parameter, so a note linking it drifts.
- `incidents.csv` — data for a ```sql runbook block.

To change the archives, unzip, edit and zip again with the `shop-main/` folder at the top.
