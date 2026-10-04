# Incident Response Policy — Oneliq

This document is the **public summary** of how Oneliq classifies, contains, and
communicates security incidents.

For vulnerability reporting, see [`SECURITY.md`](../SECURITY.md).

---

## Severity classification

| Severity | Definition | Response time |
|---|---|---|
| **SEV-1** | User funds at risk right now (frontend serving malicious code, domain hijack, router admin key compromise) | Acknowledge ≤ 15 min, mitigate ≤ 1 hour |
| **SEV-2** | App degraded but funds safe (RPC outage, quotes stale, CCTP route failing, swaps reverting) | Acknowledge ≤ 1 hour, mitigate ≤ 4 hours |
| **SEV-3** | Single feature broken (one wallet provider, one chain, one link) | Acknowledge ≤ 4 hours, mitigate ≤ 24 hours |
| **SEV-4** | Cosmetic / non-blocking (typo, layout glitch, slow load) | Acknowledge ≤ 24 hours, fix in next release |

When the severity is unclear we escalate up, not down.

---

## Roles

For any incident above SEV-3 we name three roles explicitly, even if a single
person wears multiple hats:

- **Incident Commander** — owns the timeline and final call on actions
- **Communications** — owns external messaging (status page, social, users)
- **Technical Lead** — owns diagnosis and execution of fixes

---

## Containment principles

Oneliq is a frontend plus a thin edge backend over mostly third-party contracts,
with two contracts of our own. Containment follows that architecture. These are
the levers that **actually exist**:

- **Configuration-level**: edge headers and redirects revert in seconds without a
  code push.
- **Build-level**: every Cloudflare Pages deploy is atomically rollback-able to
  any prior green build.
- **Contract-level**: `OneliqRouter.pause()` stops routing through our router.
  `OneliqCheckIn` has no owner and no pause - it cannot be stopped by us, by
  design, and does not move funds.
- **Surface-level**: disabling one product surface means a deploy or a redirect.
  There is **no** runtime feature-flag manifest. Earlier versions of this
  document described a frontend kill-switch; no such mechanism exists in the
  code, so it is not part of the plan.

**User funds are never under our custody.** If the frontend is paused or
withdrawn entirely, users keep direct on-chain access: USDC withdraw on Circle
Gateway, and swaps directly against the underlying Uniswap v4 and v3 contracts
on Arc without passing through anything of ours.

---

## Communication

For any SEV-1 or SEV-2, Oneliq will publish updates in this order and cadence:

1. **Status page** — initial banner within the SLA above
2. **Public channels** ([@oneliq_](https://x.com/oneliq_) on X, Discord) — same content, no DMs (avoids impersonation)
3. **Follow-up updates** — at least every 2 hours until resolution
4. **Resolution notice** — once mitigated, with a one-line root cause
5. **Public post-mortem** — within 7 days, with timeline, root cause, and action items

We do **not** speculate publicly during an incident, and we do **not** request
that users share keys, signatures, or seed phrases under any circumstance. Any
message asking for those, even one that appears to come from us, is fraudulent.

---

## Vendor incidents

If the incident originates in a third-party contract (Circle CCTP / Gateway,
Uniswap v4 / v3 / Permit2, Arc L1 itself):

1. We pause our router if the affected path routes through it, and ship a deploy
   that removes the affected surface otherwise.
2. We display an advisory banner pointing users to the vendor's official
   communication.
3. We do not duplicate or paraphrase vendor advisories — users are sent to the
   source.

The vendors and their disclosure channels are listed in
[`SECURITY.md`](../SECURITY.md#out-of-scope-third-party---report-to-vendor).

---

## Incidents in our own contracts

New since mainnet: a bug can now be ours rather than a vendor's.

1. `pause()` the router. This is the one lever that works without a deploy.
2. Assess whether funds are at risk or only fee accounting is affected.
3. If a fix requires new code, deploy a replacement router and point the frontend
   at it - the contracts are not behind a proxy, so there is no in-place upgrade.
4. Post-mortem per the cadence above, including the replacement address.

---

## Drills and review

We do **not** currently run scheduled incident-response drills, and this policy
has not been on a quarterly review cadence - an earlier version claimed both.
Both are listed as open items in
[`SECURITY_CHECKLIST.md`](../SECURITY_CHECKLIST.md#open-items).

What we do commit to: this document is reviewed after every real incident, and
updated when the architecture it describes changes.

---

_Last updated: 2026-10-04_
