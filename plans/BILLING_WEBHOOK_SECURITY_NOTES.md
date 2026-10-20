# Signed billing ingress acceptance

A first-party normalized billing event ingress must verify per-provider HMAC signatures over exact raw bytes, reject expired timestamps, bind the provider identity to the route, enforce tenant isolation through transactional billing updates, and preserve self-hosted operation without a billing dependency.

Acceptance requires gateway unit, integration, and CI checks before squash merge.
