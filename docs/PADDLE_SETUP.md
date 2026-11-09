# WECOMMANDER — Paddle Billing activation and release checklist

The shadcn/React web app is bundled into the existing gateway container. Its billing
pages do **not** activate subscriptions based on browser state. Only an HMAC-verified
Paddle webhook can provision or update entitlements.

## Production preconditions

1. Deploy the application and confirm the public HTTPS origin has a valid certificate.
   Configure `PUBLIC_BASE_URL=https://wecommander.app` if that is the
   intended production origin.
2. Decide whether this installation is the **Cloud SaaS** or the unlimited
   **self-hosted** edition. Self-hosted mode deliberately disables paid checkout.
   Set `DEPLOYMENT_MODE=saas` only once SaaS plans, signup and operational
   customer support are ready. Changing this flag changes entitlement logic.
3. Set real Paddle values in **Coolify environment variables**, never in the
   repository, frontend source or public configuration:
   - `PADDLE_ENVIRONMENT=sandbox` until sandbox end-to-end tests pass; `live`
     only after merchant approval, legal/billing review and a live checkout test.
   - `PADDLE_CLIENT_TOKEN=test_...` (sandbox) or `live_...` (production).
   - `PADDLE_API_KEY=...` (server-side secret).
   - `PADDLE_WEBHOOK_SECRET=pdl_ntfset_...` (notification endpoint secret).
   - For real payments, keep `PADDLE_LIVE_RELEASE_VERIFIED=false` until
     the merchant account and checkout domain are approved, a genuine
     sandbox checkout and end-to-end webhooks pass, complete legal notices
     are published, and a live checkout acceptance has been verified.
     Only then set this flag to `true` on the server; setting Paddle API
     keys alone will **not** enable live payment collection.
4. Create a Paddle notification destination at
   `https://wecommander.app/webhooks/paddle`. Subscribe to
   `subscription.created`, `subscription.activated`, `subscription.updated`,
   `subscription.trialing`, `subscription.past_due`, `subscription.paused`,
   `subscription.resumed` and `subscription.canceled`. Set the destination
   signing secret in the server environment.
5. Plans come from the built-in catalog (`gateway/src/paddle.ts`, `planCatalog`)
   and are created at startup in SaaS mode:
   - `free`: 1 device, 1 member, 2 API tokens, no payment. Every workspace
     without an active paid subscription uses it (new sign-ups, canceled,
     paused or past-due subscriptions).
   - `pro`: 5 devices, 1 member, 5 API tokens. Price: `PADDLE_PRICE_PRO`
     (`pri_...`), label `PADDLE_PRICE_PRO_LABEL` (default "9 USD / ay").
   - `team`: 25 devices, 5 members, 25 API tokens. Price:
     `PADDLE_PRICE_TEAM`, label `PADDLE_PRICE_TEAM_LABEL` (default "29 USD / ay").
   The label must match the Paddle price. Limits can be changed later in the
   console (`/console`, plan limits); the price ID and label always follow the
   environment at the next start. A plan without a valid price ID stays
   visible but cannot be bought.
   The free plan also has a monthly MCP tool-call quota (`BILLING_FREE_TOOL_CALLS`,
   default 5000; plan metadata `monthlyToolCalls`). When it is used up,
   `tools/call` returns `monthly_tool_call_limit` with the upgrade URL and
   nothing reaches a device; it resets on the 1st of the month. Paid plans
   have no call limit.
   Workspaces owned by a platform administrator (console access) are never
   limited by a plan, so switching to SaaS does not lock the operator out.
6. Configure `PUBLIC_SIGNUP_ENABLED=true` and a working SMTP/mail outbox if
   public SaaS registration should be offered.
7. Review and publish complete merchant-specific terms, privacy notice,
   refund/cancellation policy, pricing and tax disclosures before accepting
   live payments. The current short informational pages are **not** final
   legal agreements.

## Verification

- `GET /api/public/plans` displays safe public plan data and whether
  checkout is available. This endpoint **never** exposes the API key or
  webhook secret.
- Register, verify your email, log in, select an active plan, and open the
  Paddle sandbox overlay. Verify the total, tax and subscription interval.
- Complete a Paddle test payment. The new subscription is paired using
  Paddle's `subscription.created.data.transaction_id` with a server-recorded
  checkout intent. No client-selected organization ID is trusted.
- Confirm `/billing?pending=1` transitions only after the verified
  `subscription.created` / `subscription.updated` notification.
- Test subscription pause, cancellation, duplicate delivery, delayed/out-of-order
  events, price changes made in the customer portal, and the hosted portal link.
- Check the GitHub integration tests and Chrome screenshots before merging,
  and perform a manual production-domain acceptance test after deployment.

## Security

Paddle API keys and webhook secrets are never sent to the browser. Webhooks
validate their `Paddle-Signature` over the exact raw request bytes, verify the
timestamp, deduplicate events, reject unknown plan price IDs, and only provision
entitlements tied to a server-created checkout transaction or an already verified
subscription. A paused, canceled or past-due subscription is **not entitled**.
Payment UI cannot grant entitlements by itself.

## Existing user workflows

`/dashboard`, `/devices`, `/terminal`, `/files`, `/tasks`, `/mcp`,
`/usage`, `/account`, `/pricing`, `/checkout`, and `/billing` use the
new React/shadcn-inspired Fluent shell. The legacy `/app` advanced console
remains available for operations not yet migrated, especially complex terminal
sessions and high-risk file changes. It is **not** removed in this release.
