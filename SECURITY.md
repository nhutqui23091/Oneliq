# Security Policy - Oneliq

Oneliq is a unified stablecoin platform on **Arc Mainnet** (chainId 5042). We
take security seriously and welcome responsible disclosure from researchers.

---

## Scope

### In-scope
- Frontend: `https://oneliq.xyz` and all subdomains
- Edge backend: the Cloudflare Pages Functions under `/api/*` and `/auth/*`
- Public assets at `/assets/*`
- Contracts we deployed and own (see table below)

### Our contracts on Arc Mainnet

These are ours, so they are in scope. All are unaudited.

| Contract | Address | Notes |
|---|---|---|
| OneliqRouter | `0x3635f71daa996e22867647cc58358c5803133a69` | fee router, 0.3% (`feeBps` 30, capped at 1.00%), routes to Uniswap v4 + v3 |
| OneliqCheckIn | `0x0cccbe2f3acec01d71b38249a1d103117c8473ac` | no owner, no admin functions |

The router's owner key is a single EOA today, not a multi-sig. It can set the fee
within an immutable 1.00% cap, withdraw accrued fees, pause the router, and sweep
stray tokens above the fee accounting. It cannot take user funds. The full blast
radius is written out in
[`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md#known-weakness-the-router-admin-key) -
if you find a way past those limits, that is exactly the kind of report we want.

### Out-of-scope (third-party - report to vendor)
| Asset | Owner | Report to |
|---|---|---|
| USDC, EURC, CCTP, Gateway | Circle | https://www.circle.com/legal/responsible-disclosure |
| Uniswap v4 (Universal Router, PoolManager), v3 (SwapRouter02), Permit2 | Uniswap Labs | security@uniswap.org |
| Arc L1 chain, public RPC, block explorer | Arc | security@arc.network |

---

## Reporting a vulnerability

**Channel**: email **security@oneliq.xyz**.

We do not publish a PGP key, so assume mail is unencrypted. If a finding is
sensitive enough that it should not travel in plaintext, send a short note
without details and we will agree on a channel first.

**Do NOT**:
- Open a public GitHub issue
- Disclose on Twitter / Discord before we patch
- Test in any way that risks other people's funds, spams the chain, or degrades
  the service for other users

Mainnet is the live environment, so test against your own wallet and your own
positions only.

**Please include**:
1. Type of issue (XSS, supply chain, frontend phishing vector, RPC injection, contract logic, etc.)
2. Affected URL / file / commit hash / contract address
3. Step-by-step reproduction
4. Proof-of-concept (screenshots, video, or code)
5. Impact assessment
6. Suggested mitigation (optional)

We acknowledge reports within **48 hours** and aim to triage within **5 business days**.

---

## Severity & rewards

**There is no funded bug-bounty program today.** Oneliq is pre-revenue and has
no bounty pool, so we are not going to publish reward tiers we cannot honour.

What a valid report does get:

- Triage and a fix, with the timeline above
- Credit in the Hall of Fame below, unless you ask to stay anonymous
- A discretionary thank-you, agreed case by case, in proportion to impact and to
  what the project can afford at the time

If and when a funded program launches, the scope and the numbers will be
published here and announced publicly.

We classify severity as follows, which drives priority, not payment:

| Severity | Examples |
|---|---|
| **Critical** | frontend supply-chain compromise, key extraction, fund-draining tx injection, router logic that lets anyone move another user's approved funds |
| **High** | persistent XSS leading to wallet drain, DNS / build-pipeline takeover, auth bypass on a wallet-scoped endpoint |
| **Medium** | reflected XSS, CSP bypass, auth bypass on an admin route, fee or accounting error in the router |
| **Low** | clickjacking, missing security headers, information disclosure |

---

## Safe harbor

We will not pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations, data destruction, or
  service interruption
- Only interact with their own accounts, their own wallets, or test accounts
- Give us reasonable time to respond before public disclosure (90 days default)
- Do not exploit the vulnerability beyond what is necessary to prove it

---

## Hall of Fame

Researchers who responsibly disclose valid issues will be credited here
(unless they request anonymity).

| Researcher | Severity | Date | Issue |
|---|---|---|---|
| _(none yet)_ | | | |

---

## Past incidents

None disclosed to date. This file will be updated transparently if and when an
incident occurs.

---

_Last updated: 2026-10-04_
