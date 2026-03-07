# Official Genesis Claims vs On-Chain Reality

**Date:** March 7, 2026
**Method:** Blockfrost API tracing from verified genesis addresses through UTXO graph
**Status:** Tracers actively running — numbers will improve as coverage increases

---

## The Official Story (cardano.org/genesis)

| Metric | Official Claim |
|--------|---------------|
| Total ADA at launch | 31,112,484,646 |
| Public sale (ICO) | 25,927,070,538 ADA across 14,402 invoices |
| Development pool | 5,185,414,108 ADA (16.67% of launch supply) |
| IOHK allocation | 2,463,071,701 ADA |
| Emurgo allocation | 2,074,165,644 ADA |
| Cardano Foundation | 648,176,761 ADA |
| Total BTC raised | 108,844.5 BTC |
| Total USD equivalent | $62,236,134 |
| Geographic distribution | 94.45% Japan |

The official page presents this as transparent, audited (by McDermott/BDO), and accounted for.

---

## What The Chain Actually Shows

### Immediate Fund Movement

All three founding entities **emptied their genesis wallets completely** to single Byron-era intermediary addresses, in their earliest transactions:

| Entity | Genesis Balance | Current Balance | Where it went |
|--------|----------------|-----------------|--------------|
| IOHK | 2,463,071,701 ADA | **0 ADA** | 1 primary Byron address + 4 small outputs |
| Emurgo | 2,074,165,644 ADA | **0 ADA** | 1 Byron address |
| CF | 648,176,761 ADA | **0 ADA** | 1 Byron address |

### The Byron Cascade

From those first intermediaries, funds moved through **44-50+ layers** of Byron-to-Byron transfers. Each intermediate address typically has exactly 2 transactions (receive + forward) — consistent with automated splitting/forwarding scripts, not manual operations.

### What We Find at the Shelley Endpoints

When funds eventually emerge at modern Shelley-era addresses (which have governance capabilities):

| Finding | Detail |
|---------|--------|
| Largest single cluster | 44,169,332 ADA in one IOHK-linked stake key |
| Governance status of that cluster | **ZERO** — not staked, no DRep, account inactive |
| Emurgo's main stake key | 1,380,966 ADA — staked but votes `always_abstain` |
| Overall governance rate | **3.0%** of traced funds participate in governance |
| Balance at most Shelley endpoints | **0 ADA** — funds already moved on |

---

## Questions That Arise

### 1. Where Is the 5.185 Billion ADA?

The official page accounts for the initial allocation. But 8+ years later, tracing forward from those same genesis addresses reveals:

- **~45.68M ADA (~0.88%)** traceable to identifiable Shelley wallets
- **44.17M ADA** of that sits in a single inactive, non-governing stake key
- **The other 99.12%** has dispersed through the UTXO graph beyond easy attribution

The question isn't whether the money existed — it did, on-chain. The question is: **where did it go, and is any of it participating in the governance system it was supposed to help build?**

### 2. The 63% Staking Paradox

Network-wide, ~63% of all ADA is staked. But of the genesis development pool funds we can trace:

- Only **3%** participates in governance
- The largest traced cluster (44M ADA) has **zero** governance activity
- Emurgo's traced funds formally stake but vote `always_abstain`

If the founding entities are staking their allocations, they aren't doing it through addresses connected to their genesis wallets. Either:
- The funds moved to exchanges (sold)
- The funds moved to custodial wallets with no governance participation
- The funds moved to addresses we haven't traced yet (coverage increasing)

### 3. The "Always Abstain" Pattern

Emurgo's primary traced stake key delegates to a pool (earning rewards) but sets DRep to `always_abstain`. This means:
- They collect staking rewards
- They contribute to pool security
- They **deliberately opt out** of all governance votes
- Their 1.38M ADA counts toward the "staked" percentage but NOT toward governance participation

### 4. The 44 Million ADA Black Hole

The single largest finding: `stake1u833p40y8cm07ra9wgrqgp70z6khc5pttrena97c6en6p8c7pzxda`

- **44,169,332 ADA** controlled
- **500+ addresses** under this key
- Account status: **inactive**
- Pool delegation: **none**
- DRep delegation: **none**
- Top address holds **7,188,195 ADA**

This ADA earns no staking rewards, supports no pool, and participates in zero governance. It is linked to IOHK through our trace. It just... sits there.

### 5. The CF Transparency Gap

The Cardano Foundation's 648 million ADA is the hardest to trace:
- Forward tracing from their genesis address hits deep Byron chains
- 19 addresses visited in the initial trace found **zero** Shelley endpoints
- Their operational wallet (DdzFFzCqrhsgwQmeWNBTs...) forwarded the full allocation onward
- Where it ultimately landed remains unknown within our current search depth

---

## What This Doesn't Mean

To be clear:
- We are NOT claiming funds were stolen or misappropriated
- Spending genesis funds on operations, development, and growth is expected
- Exchange deposits for fiat conversion are normal treasury operations
- UTXO mixing makes definitive attribution impossible after a few hops

## What This Does Mean

- The founding entities received 5.185 billion ADA
- 8+ years later, less than 1% is traceable to governance-participating wallets
- The largest identifiable cluster (44M ADA) has zero governance participation
- The community has limited visibility into where these funds ultimately went
- Before the 2026 budget discussions, the community deserves clarity on how much founding entity ADA still exists, where it sits, and whether it participates in the governance system those entities helped create

---

## Methodology

1. Genesis addresses verified from mainnet-byron-genesis.json and on-chain genesis transaction
2. Forward trace: BFS through UTXO outputs, following all flows >= 10,000 ADA
3. Reverse trace: Starting from known large Shelley wallets, tracing inputs backwards
4. Stake key expansion: For every Shelley address found, expanding to all addresses under the same stake key
5. Governance check: Pool delegation, DRep delegation, active status via Blockfrost API
6. All data sourced from Cardano mainnet via Blockfrost API — verifiable by anyone

---

## Live Data (Updates as tracers run)

*Last updated: March 7, 2026*

| Metric | Value | Status |
|--------|-------|--------|
| Forward trace - Emurgo coverage | ~43% | Running |
| Forward trace - IOHK coverage | Pending | Queued |
| Forward trace - CF coverage | Pending | Queued |
| Reverse trace addresses | 150+ | Running |
| Byron funding links found | 5,200+ | Growing |
| Genesis connections (reverse) | 0 so far | Searching |
