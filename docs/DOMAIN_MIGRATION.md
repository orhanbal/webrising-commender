# Domain migration: `wecommander.webrising.tr` → `wecommander.app`

Both domains serve the same gateway during the transition, so enrolled
agents keep working. The gateway's identity (`PUBLIC_BASE_URL`) moves to the
new domain. That identity is used as the OAuth issuer and MCP resource, in
e-mail links and as the browser cookie host.

## Steps

1. **DNS (owner):** add `A` records for `wecommander.app` and
   `www.wecommander.app` pointing to `148.135.181.148`. `.app` is
   HSTS-preloaded, so only HTTPS works; Coolify/Traefik obtains the
   certificate.
2. **Code (this change):** the defaults for new installs (setup scripts,
   Windows installer, compose files, console install page, production-guard
   fallback) use `https://wecommander.app`.
3. **Coolify:** set the gateway domains to
   `https://wecommander.app,https://www.wecommander.app,https://wecommander.webrising.tr,https://www.wecommander.webrising.tr`
   and `PUBLIC_BASE_URL=https://wecommander.app`. Both settings take effect
   on the next `promote-production` release. Do this only after step 1
   resolves, otherwise the OAuth issuer would point to an unreachable host.
4. **GitHub (owner):** Settings → Environments → `production` → variable
   `PRODUCTION_BASE_URL` = `https://wecommander.app`.
5. **Release:** `promote-production`; `/health` on the new domain must report
   the released SHA. Then run `production-guard` manually.
6. **AI clients (owner):** remove the old connector and add
   `https://wecommander.app/mcp`. Tokens issued for the old resource no longer
   work, by design.
7. **Agents:** on each device, as root:

   ```bash
   sudo -u wecommander /opt/wecommander/bin/webrising-commender --config /var/lib/webrising-commender/agent.json set-control-url --url https://wecommander.app
   ```

   ```bash
   sudo systemctl restart webrising-commender
   ```

   Device identity, token and capabilities are kept. A gateway WebSocket URL
   on another host (a regional relay) is left unchanged.
8. **After at least 3 months:** redirect the old domain to the new one, and
   remove it once no device reports in through it.

## Rollback

Set `PUBLIC_BASE_URL` back to `https://wecommander.webrising.tr` and release.
Agents that were already moved can run `set-control-url` with the old URL.
