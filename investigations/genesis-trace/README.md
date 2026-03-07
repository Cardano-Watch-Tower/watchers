# Genesis Fund Trace

**Status:** In Progress (exhaustive scan running)
**Started:** March 7, 2026

## The Question

Where did Cardano's 5.185 billion ADA development pool go, and does it participate in governance?

## The Answer (So Far)

The development pool was split among three founding entities:
- **IOHK/Input Output** — 2.46B ADA (48%)
- **Emurgo** — 2.07B ADA (40%)
- **Cardano Foundation** — 648M ADA (12%)

All three entities fully emptied their genesis addresses. Funds cascaded through 15-50+ layers of Byron-era intermediary addresses before reaching Shelley-era wallets.

### Governance Participation of Genesis-Linked Funds

| Status | Current ADA | % |
|--------|------------|---|
| No governance (pool staking only) | 2,075,765,522 | 78.9% |
| Deliberately abstains | 422,421,097 | 16.1% |
| Emurgo's own DRep | 123,272,145 | 4.7% |
| No confidence | 7,235,577 | 0.3% |
| Any independent DRep | 0 | 0% |

**Zero genesis-linked ADA delegates to any independent, community-elected DRep.**

The only real governance participation circles back to Emurgo's own DRep — a founding entity voting with its own original allocation.

### Key Discoveries

1. **The 1.89B ADA Treasury** splits 32M ADA chunks to 11+ stake keys, all set to `always_abstain`
2. **The 44M ADA Black Hole** (IOHK-linked) sits completely idle — no staking, no governance
3. **The Circular Governance Loop** — Emurgo genesis funds delegate back to Emurgo's DRep (30.8% of its voting power)
4. **The No-Confidence Whale** — 7.2M ADA with permanent `no_confidence` stance, centrally connected in the genesis network

## Documentation

- **[FINDINGS.md](FINDINGS.md)** — Full investigation report with methodology and data
- **[COMPARISON.md](COMPARISON.md)** — Comparative analysis

## Tools

All tracer scripts are in the [`tools/`](tools/) directory. Built on Node.js with the Blockfrost API.

## Methodology

11-phase investigation pipeline:
1. Genesis first-hop trace
2. Deep recursive trace (BFS, 15 hops)
3. Full forward trace (uncapped BFS, 50+ hops)
4. Reverse trace from known large wallets
5. Stake key expansion and governance check
6. Drain trace (where 0-balance endpoints sent funds)
7. DRep delegation analysis
8. Neighborhood scan (entity clustering)
9. Deep dive (treasury, hub wallet, DRep, whale)
10. DRep delegator genesis trace (all 400 Emurgo delegators)
11. Link-chain aggregation (chain-of-custody records)

---

*Investigation ongoing. Exhaustive uncapped scans currently running.*
