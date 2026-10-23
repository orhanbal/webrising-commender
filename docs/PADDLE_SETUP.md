# WECOMMANDER — Paddle Billing activation and release checklist

The shadcn/React web app is bundled into the existing gateway container. Its billing
pages do **not** activate subscriptions based on browser state. Only an HMAC-verified
Paddle webhook can provision or update entitlements.

## Production preconditions

1. Deploy the application and confirm the public HTTPS origin has a valid certificate.
   Configure `PUBLIC_BASE_URL=https://wecommander.webrising.tr` if that is the
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
4. Create a Paddle notification destination at
   `https://wecommander.webrising.tr/webhooks/paddle`. Subscribe to
   `subscription.created`, `subscription.activated`, `subscription.updated`,
   `subscription.trialing`, `subscription.past_due`, `subscription.paused`,
   `subscription.resumed` and `subscription.canceled`. Set the destination
   signing secret in the server environment.
5. Create an active billing plan in the **global-admin plan endpoint**
   `POST /api/admin/billing/plans` (global-admin credentials only), including
   price metadata. Example (replace all example values):
   ```json
   {
     "key": "pro",
     "name": "Pro",
     "maxDevices": 5,
     "maxMembers": 2,
     "maxApiTokens": 5,
     "metadata": {
       "paddlePriceId": "pri_01exampleReplaceWithRealPriceId",
       "priceLabel": "Price verified in checkout",
       "description": "Individual remote workspace",
       "features": ["5 devices", "2 seats", "MCP access"],
       "featured": true
     },
     "active": true
   }
   ```
   The *actual* price is controlled by the Paddle price ID. Display labels
   must match the Paddle product, currency, interval, and tax disclosures.
   Reusing the same price ID for multiple plans is disallowed in fulfillment.
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
