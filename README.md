# token radar — radar-3

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/asenamapr/token-radar-01-v2/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/asenamapr/token-radar-01-v2/reward.svg)](https://make.fun/bounty/token-radar-01)

Bounty: [token-radar-01](https://make.fun/bounty/token-radar-01)

A token-launch radar: it reads a frozen DefiLlama snapshot of 758 protocols,
fits a value curve on the 128 live tokens in it, ranks the 198 pre-token
protocols by what their launch would be worth, and nets every farm plan to
the dollar.

## The model

Three members price a pre-token protocol from its TVL, 7-day TVL growth, age
and chain count; an ensemble weights them by internal out-of-sample MAE.

- **Member A — OLS curve.** Least squares of ln(market cap) on
  `[1, lnTvl, growth, lnAge, chains]`, plus a shrunk per-category effect
  (category mean residual × n / (n + 8)).
- **Member B — LAD robust curve.** The same features, iteratively reweighted
  least squares (8 rounds, Huber weights), starting from the OLS fit.
- **Member C — neighbours.** The 8 nearest live protocols by |lnTvl
  difference| in the same category (all live when the category has fewer
  than 4), median market-cap/TVL ratio clamped to [0.05, 1.0].
- **Ensemble.** Weighted mean of the three members' log-values, weights on
  the simplex in steps of 0.05, fitted by minimising MAE on internal 2-fold
  out-of-sample predictions (split by slug-hash parity). The baseline —
  per-category median market-cap/TVL ratio, else the global median — is for
  comparison only and never enters the ensemble.

Implied value = exp(ensemble log prediction), rounded to whole dollars,
clamped to [1, 10^14].

## The numbers (computed at runtime from the snapshot)

- Board: 198 rows — all 40 watchlist protocols, 138 rankable below the
  $50,000,000 floor, 20 rankable above it (60 above the floor in total).
- Fitted ensemble weights: OLS 0.45, LAD 0.00, neighbours 0.55. Fitted growth
  coefficients: −3.892 (OLS) and −2.271 (LAD) — both negative.
- Out-of-sample backtest (5-fold cross-validation, fold = slug hash % 5,
  128 live tokens):

  | Method | MAE-log | Within 2× | vs baseline |
  | --- | --- | --- | --- |
  | Median baseline | 1.922 | 24.2% | — |
  | OLS curve | 1.602 | 29.7% | +16.6% |
  | LAD robust curve | 1.595 | 33.6% | +17.0% |
  | Neighbours | 1.839 | 22.7% | +4.4% |
  | Ensemble | 1.731 | 25.8% | +10.0% |

- Stress test: 200 bootstrap refits (seeded PRNG) evaluated on out-of-bag
  live protocols; median improvement over the baseline +10.0%, 10th
  percentile +2.5%, the ensemble beats the baseline in 94.5% of refits.
- Growth-tilt diagnostic: a fourth member (neighbours plus the 7-day growth
  tilt) takes weight 0.55 in the same grid search but only swaps weight with
  the plain neighbours member — internal out-of-sample MAE moves from 1.679
  to 1.676, a 0.2% gain — so the tilt adds essentially nothing.
- Verdicts: 9 FARM, 187 THIN, 2 SKIP. Top row: Bittensor dTAO,
  $126,493,431 implied, net +$106.15 to farm.

## Honest limits

- The fitted growth coefficient is **negative**: at the same TVL, a protocol
  whose TVL grew fast in the last 7 days is predicted a **lower** market
  cap — the market discounts hot money.
- The curve is fitted on only 128 live tokens.
- The farmer count (clamp(round(4000 × √(TVL / $1M)), 5,000, 400,000)) and
  the 7% allocation to farmers are assumptions, not measurements.
- The snapshot carries no parent-protocol field, so this entry cannot verify
  parentage.

## The board rule

A row is every pre-token protocol (market cap, CoinGecko id and symbol all
null) that passes the watchlist's own exclusion rule: category not Bridge,
Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX;
name not ending in a version marker; no whole word wrapped, staked or
staking; name not starting with an exchange name. No protocol is
special-cased by name. The watchlist is a floor, never a ceiling: the board
carries the rankable protocols above the floor too.

## Farm plans

Every row carries 6 steps: a fresh wallet, the category action with the
capital and the first chain, one qualifying action a week, the hold, claiming
only from the protocol's own points/rewards page, and the net line. Capital
by TVL tier: ≥ $1B → $250, ≥ $100M → $150, ≥ $10M → $100, else $50. Gas:
$8 when capital ≥ $150, else $4. Hold: 60 days when age < 180, 45 when age
< 365, else 30. Net = implied × 7% ÷ farmers − gas. Verdict: FARM when net
> $50, THIN when $0 ≤ net ≤ $50, SKIP when net < $0.

## How to run

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Reads the snapshot, writes `board.json`, `data.js`, `dashboard/` and
`screenshots/` to the output directory, then `dossier.json`. The run exits 1
when `screenshots/` does not hold exactly the three required screenshots —
after writing the data files, so the screenshots can be rendered from the
output dashboard and the run repeated. The run is deterministic: two runs
write byte-identical trees.

## Disclaimer

Implied values are this entry's own claim, fitted on the snapshot's live
tokens — not a price, not advice, and no token is promised. A farm plan is
a plan, not a guarantee.
