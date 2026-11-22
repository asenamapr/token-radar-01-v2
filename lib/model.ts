// lib/model.ts — radar-3: a value curve fitted on the snapshot's live tokens.
//
// The snapshot's live set (protocols with a market cap and TVL, both above zero)
// is the only pricing evidence. Three members price a pre-token protocol from its
// TVL, 7-day TVL growth, age and chain count; an ensemble weights them by internal
// out-of-sample MAE. Everything is fitted at runtime from the snapshot — no
// protocol is named, no coefficient is hardcoded, and no date or random value is
// read at run time: the only randomness is a seeded PRNG for the bootstrap.
//
// Members:
//   A — OLS curve: ln(mcap) on [1, lnTvl, growth, lnAge, chains] + shrunk
//       per-category residual effect.
//   B — LAD robust curve: the same features, iteratively reweighted least squares
//       with Huber weights, starting from the OLS fit.
//   C — neighbours: the 8 nearest live protocols by |lnTvl difference| in the
//       same category (all live when the category has fewer than 4), median
//       mcap/TVL ratio clamped to [0.05, 1.0].
// The baseline (for comparison only, never in the ensemble) is the per-category
// median mcap/TVL ratio, else the global median.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Features {
  lnTvl: number;
  g: number;
  lnAge: number;
  chains: number;
  category: string;
}

export interface LivePoint {
  slug: string;
  category: string;
  lnTvl: number;
  lnMcap: number;
  ratio: number;
  feat: Features;
}

// ---------------------------------------------------------------- utilities

/** Slug hash: h = h*31 + charCode, kept in 32 bits (>>> 0) so the value stays
 *  an exact integer in double arithmetic — a raw accumulation passes 2^53 and
 *  its parity (the 2-fold split) and its low folds degenerate. */
export function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

const DAY_MS = 86400000;

export function ageDays(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 365;
  const asOfMs = Date.parse(asOf + 'T00:00:00Z');
  const listedMs = Date.parse(listedAt + 'T00:00:00Z');
  const d = Math.floor((asOfMs - listedMs) / DAY_MS);
  return d < 0 ? 0 : d;
}

export function features(p: Protocol, asOf: string): Features {
  const g = p.change_7d === null ? 0 : Math.max(-50, Math.min(100, p.change_7d)) / 100;
  return {
    lnTvl: Math.log(p.tvl_usd),
    g,
    lnAge: Math.log(1 + ageDays(p.listed_at, asOf)),
    chains: Math.min(p.chains.length, 10),
    category: p.category ?? 'Unknown',
  };
}

export function median(nums: number[]): number {
  if (nums.length === 0) throw new Error('median of an empty list');
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solveLinear(aIn: number[][], bIn: number[]): number[] {
  const n = bIn.length;
  const m = aIn.map((row, i) => [...row, bIn[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-14) throw new Error('solveLinear: singular matrix');
    if (piv !== col) {
      const t = m[col];
      m[col] = m[piv];
      m[piv] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n];
    for (let c = r + 1; c < n; c++) s -= m[r][c] * x[c];
    x[r] = s / m[r][r];
  }
  return x;
}

/** Deterministic PRNG (mulberry32) for the bootstrap; fixed seed, no Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- live set

export function livePoints(snap: Snapshot): LivePoint[] {
  return snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => {
      const feat = features(p, snap.as_of);
      return {
        slug: p.slug,
        category: feat.category,
        lnTvl: feat.lnTvl,
        lnMcap: Math.log(p.mcap_usd as number),
        ratio: (p.mcap_usd as number) / p.tvl_usd,
        feat,
      };
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

// ---------------------------------------------------------------- members

function designRow(f: Features): number[] {
  return [1, f.lnTvl, f.g, f.lnAge, f.chains];
}

export interface CurveFit {
  beta: number[];
  catEffect: Record<string, number>;
}

function categoryEffects(points: LivePoint[], beta: readonly number[]): Record<string, number> {
  const groups = new Map<string, number[]>();
  for (const p of points) {
    const r = p.lnMcap - dot(designRow(p.feat), beta);
    const arr = groups.get(p.category);
    if (arr) arr.push(r);
    else groups.set(p.category, [r]);
  }
  const out: Record<string, number> = {};
  for (const [cat, rs] of groups) {
    const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
    out[cat] = mean * (rs.length / (rs.length + 8));
  }
  return out;
}

function weightedLeastSquares(points: LivePoint[], weights: number[] | null): number[] {
  const k = 5;
  const a: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const w = weights === null ? 1 : weights[i];
    const x = designRow(p.feat);
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) a[r][c] += w * x[r] * x[c];
      b[r] += w * x[r] * p.lnMcap;
    }
  }
  for (let i = 0; i < k; i++) a[i][i] += 1e-8;
  return solveLinear(a, b);
}

/** Member A: ordinary least squares of ln(mcap) on the five features. */
export function olsFit(points: LivePoint[]): CurveFit {
  const beta = weightedLeastSquares(points, null);
  return { beta, catEffect: categoryEffects(points, beta) };
}

/** Member B: LAD robust curve — IRLS with Huber weights, 8 rounds from the OLS fit. */
export function ladFit(points: LivePoint[], startBeta: readonly number[]): CurveFit {
  let beta = [...startBeta];
  for (let iter = 0; iter < 8; iter++) {
    const res = points.map((p) => p.lnMcap - dot(designRow(p.feat), beta));
    const s = 1.4826 * median(res.map((r) => Math.abs(r)));
    if (!(s > 1e-12)) break;
    const w = res.map((r) => 1 / Math.max(1, Math.abs(r) / (1.345 * s)));
    beta = weightedLeastSquares(points, w);
  }
  return { beta, catEffect: categoryEffects(points, beta) };
}

export function predictLog(fit: CurveFit, f: Features): number {
  return dot(designRow(f), fit.beta) + (fit.catEffect[f.category] ?? 0);
}

export interface BaselineRatios {
  byCat: Record<string, number>;
  global: number;
}

export function baselineRatios(points: LivePoint[]): BaselineRatios {
  const global = median(points.map((p) => p.ratio));
  const groups = new Map<string, number[]>();
  for (const p of points) {
    const arr = groups.get(p.category);
    if (arr) arr.push(p.ratio);
    else groups.set(p.category, [p.ratio]);
  }
  const byCat: Record<string, number> = {};
  for (const [cat, rs] of groups) if (rs.length >= 4) byCat[cat] = median(rs);
  return { byCat, global };
}

export function baselineLogPred(base: BaselineRatios, f: Features): number {
  return f.lnTvl + Math.log(base.byCat[f.category] ?? base.global);
}

/** Member C: neighbours — 8 nearest live protocols by |lnTvl difference| in the
 *  same category (all live when the category has fewer than 4), median ratio
 *  clamped to [0.05, 1.0]. */
export function neighbourLogPred(train: LivePoint[], f: Features): number {
  let pool = train.filter((p) => p.category === f.category);
  if (pool.length < 4) pool = train;
  const near = [...pool]
    .sort((a, b) => {
      const d = Math.abs(a.lnTvl - f.lnTvl) - Math.abs(b.lnTvl - f.lnTvl);
      return d !== 0 ? d : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    })
    .slice(0, 8);
  const ratio = Math.max(0.05, Math.min(1.0, median(near.map((p) => p.ratio))));
  return f.lnTvl + Math.log(ratio);
}

export interface MemberLogs {
  ols: number;
  lad: number;
  neighbours: number;
  baseline: number;
  ensemble: number;
}

export interface Pipeline {
  ols: CurveFit;
  lad: CurveFit;
  weights: [number, number, number];
  base: BaselineRatios;
  train: LivePoint[];
}

export function memberLogs(pipe: Pipeline, f: Features): MemberLogs {
  const ols = predictLog(pipe.ols, f);
  const lad = predictLog(pipe.lad, f);
  const neighbours = neighbourLogPred(pipe.train, f);
  const baseline = baselineLogPred(pipe.base, f);
  const ensemble = pipe.weights[0] * ols + pipe.weights[1] * lad + pipe.weights[2] * neighbours;
  return { ols, lad, neighbours, baseline, ensemble };
}

// ---------------------------------------------------------------- ensemble weights

export interface OosPoint {
  actual: number;
  ols: number;
  lad: number;
  neighbours: number;
  baseline: number;
  /** The protocol's 7-day growth feature, for the growth-tilt diagnostic. */
  g: number;
}

/** Internal 2-fold out-of-sample predictions on a training set, split by
 *  slug-hash parity, fitting the members on the other half each time. */
export function internalOos(train: LivePoint[]): OosPoint[] {
  const out: OosPoint[] = [];
  for (const parity of [0, 1]) {
    const tr = train.filter((p) => slugHash(p.slug) % 2 === parity);
    const te = train.filter((p) => slugHash(p.slug) % 2 !== parity);
    if (tr.length === 0 || te.length === 0) continue;
    const ols = olsFit(tr);
    const lad = ladFit(tr, ols.beta);
    const base = baselineRatios(tr);
    for (const p of te) {
      out.push({
        actual: p.lnMcap,
        ols: predictLog(ols, p.feat),
        lad: predictLog(lad, p.feat),
        neighbours: neighbourLogPred(tr, p.feat),
        baseline: baselineLogPred(base, p.feat),
        g: p.feat.g,
      });
    }
  }
  return out;
}

/** Ensemble weights on the simplex in steps of 0.05, minimising MAE on the
 *  internal out-of-sample predictions. Equal weights when the fit fails. */
export function fitWeights(oos: OosPoint[]): [number, number, number] {
  if (oos.length === 0) return [1 / 3, 1 / 3, 1 / 3];
  let best: [number, number, number] = [1 / 3, 1 / 3, 1 / 3];
  let bestMae = Infinity;
  for (let a = 0; a <= 20; a++) {
    for (let b = 0; b <= 20 - a; b++) {
      const c = 20 - a - b;
      const wa = a / 20;
      const wb = b / 20;
      const wc = c / 20;
      let s = 0;
      for (const p of oos) s += Math.abs(wa * p.ols + wb * p.lad + wc * p.neighbours - p.actual);
      const mae = s / oos.length;
      if (mae < bestMae) {
        bestMae = mae;
        best = [wa, wb, wc];
      }
    }
  }
  return best;
}

export function fitPipeline(train: LivePoint[]): Pipeline {
  const ols = olsFit(train);
  const lad = ladFit(train, ols.beta);
  const base = baselineRatios(train);
  const weights = fitWeights(internalOos(train));
  return { ols, lad, weights, base, train };
}

export interface GrowthTiltResult {
  /** Weight the grid search puts on the tilted member. */
  weight: number;
  /** Internal out-of-sample MAE with three members, and with the tilted member. */
  mae3: number;
  mae4: number;
}

/** Diagnostic: a fourth member — the neighbours prediction plus the 7-day growth
 *  tilt (coefficient 1 on g) — in the same simplex grid search, to test whether
 *  a ratio-style growth tilt adds anything beyond the three members. The
 *  ensemble itself keeps the three members above; this only measures the tilt's
 *  marginal value, as the weight it takes and the MAE it saves. */
export function fitGrowthTilt(oos: OosPoint[]): GrowthTiltResult {
  const maeOf = (w: readonly number[]): number => {
    let s = 0;
    for (const p of oos) s += Math.abs(w[0] * p.ols + w[1] * p.lad + w[2] * p.neighbours + w[3] * (p.neighbours + p.g) - p.actual);
    return s / oos.length;
  };
  if (oos.length === 0) return { weight: 0, mae3: 0, mae4: 0 };
  let best3Mae = Infinity;
  for (let a = 0; a <= 20; a++) {
    for (let b = 0; b <= 20 - a; b++) {
      const c = 20 - a - b;
      const mae = maeOf([a / 20, b / 20, c / 20, 0]);
      if (mae < best3Mae) best3Mae = mae;
    }
  }
  let bestD = 0;
  let best4Mae = Infinity;
  for (let a = 0; a <= 20; a++) {
    for (let b = 0; b <= 20 - a; b++) {
      for (let c = 0; c <= 20 - a - b; c++) {
        const d = 20 - a - b - c;
        const mae = maeOf([a / 20, b / 20, c / 20, d / 20]);
        if (mae < best4Mae) {
          best4Mae = mae;
          bestD = d / 20;
        }
      }
    }
  }
  return { weight: bestD, mae3: best3Mae, mae4: best4Mae };
}

export function impliedFromLog(logPred: number): number {
  const v = Math.round(Math.exp(logPred));
  return Math.max(1, Math.min(100000000000000, v));
}

// ---------------------------------------------------------------- backtest

export interface MethodStats {
  maeLog: number;
  within2x: number;
  improvementPct: number;
}

export interface OosTable {
  n: number;
  baseline: MethodStats;
  ols: MethodStats;
  lad: MethodStats;
  neighbours: MethodStats;
  ensemble: MethodStats;
}

/** 5-fold cross-validation, fold = slugHash % 5. Per fold the members are fitted
 *  on the other four folds and the ensemble weights on the training folds'
 *  internal 2-fold out-of-sample predictions. */
export function crossValidate(live: LivePoint[]): OosTable {
  const absErr: Record<string, number[]> = { baseline: [], ols: [], lad: [], neighbours: [], ensemble: [] };
  for (let fold = 0; fold < 5; fold++) {
    const train = live.filter((p) => slugHash(p.slug) % 5 !== fold);
    const test = live.filter((p) => slugHash(p.slug) % 5 === fold);
    if (train.length === 0 || test.length === 0) continue;
    const pipe = fitPipeline(train);
    for (const p of test) {
      const m = memberLogs(pipe, p.feat);
      absErr.baseline.push(Math.abs(m.baseline - p.lnMcap));
      absErr.ols.push(Math.abs(m.ols - p.lnMcap));
      absErr.lad.push(Math.abs(m.lad - p.lnMcap));
      absErr.neighbours.push(Math.abs(m.neighbours - p.lnMcap));
      absErr.ensemble.push(Math.abs(m.ensemble - p.lnMcap));
    }
  }
  const n = absErr.ensemble.length;
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const baseMae = mean(absErr.baseline);
  const stats = (key: string): MethodStats => {
    const mae = mean(absErr[key]);
    return {
      maeLog: mae,
      within2x: absErr[key].filter((e) => e < Math.LN2).length / absErr[key].length,
      improvementPct: baseMae === 0 ? 0 : ((baseMae - mae) / baseMae) * 100,
    };
  };
  return {
    n,
    baseline: stats('baseline'),
    ols: stats('ols'),
    lad: stats('lad'),
    neighbours: stats('neighbours'),
    ensemble: stats('ensemble'),
  };
}

// ---------------------------------------------------------------- bootstrap

export interface BootstrapResult {
  refits: number;
  medianImprovementPct: number;
  p10ImprovementPct: number;
  shareBeatsBaseline: number;
}

/** 200 bootstrap refits with the seeded PRNG: resample the live set with
 *  replacement, refit the full pipeline including weights, evaluate on the
 *  out-of-bag live protocols. */
export function bootstrap(live: LivePoint[], refits = 200, seed = 20261114): BootstrapResult {
  const rand = mulberry32(seed);
  const improvements: number[] = [];
  let beats = 0;
  for (let r = 0; r < refits; r++) {
    const sample: LivePoint[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < live.length; i++) {
      const pick = live[Math.floor(rand() * live.length)];
      sample.push(pick);
      seen.add(pick.slug);
    }
    const oob = live.filter((p) => !seen.has(p.slug));
    if (oob.length === 0) continue;
    const pipe = fitPipeline(sample);
    let baseSum = 0;
    let ensSum = 0;
    for (const p of oob) {
      const m = memberLogs(pipe, p.feat);
      baseSum += Math.abs(m.baseline - p.lnMcap);
      ensSum += Math.abs(m.ensemble - p.lnMcap);
    }
    const baseMae = baseSum / oob.length;
    const ensMae = ensSum / oob.length;
    const imp = baseMae === 0 ? 0 : ((baseMae - ensMae) / baseMae) * 100;
    improvements.push(imp);
    if (imp > 0) beats++;
  }
  improvements.sort((a, b) => a - b);
  const pct = (q: number): number => {
    if (improvements.length === 0) return 0;
    const pos = q * (improvements.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return improvements[lo] + (improvements[hi] - improvements[lo]) * (pos - lo);
  };
  return {
    refits: improvements.length,
    medianImprovementPct: pct(0.5),
    p10ImprovementPct: pct(0.1),
    shareBeatsBaseline: improvements.length === 0 ? 0 : beats / improvements.length,
  };
}

// ---------------------------------------------------------------- board rule

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_START = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

export function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The watchlist's own exclusion rule, applied to every pre-token protocol. No
 *  protocol is ever special-cased by name. */
export function passesBoardRule(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_START.some((x) => p.name.startsWith(x))) return false;
  return true;
}

// ---------------------------------------------------------------- farm plans

export interface FarmMath {
  capital: number;
  gas: number;
  holdDays: number;
  farmers: number;
  expected: number;
  net: number;
  p10: number;
  p90: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
}

/** Netting, per row, at runtime. Assumptions, stated in the methodology: 7% of
 *  the implied value is allocated to farmers; the farmer count grows with the
 *  square root of TVL. */
export function farmMath(p: Protocol, implied: number, asOf: string): FarmMath {
  const tvl = p.tvl_usd;
  const capital = tvl >= 1e9 ? 250 : tvl >= 1e8 ? 150 : tvl >= 1e7 ? 100 : 50;
  const gas = capital >= 150 ? 8 : 4;
  const age = ageDays(p.listed_at, asOf);
  const holdDays = age < 180 ? 60 : age < 365 ? 45 : 30;
  const farmers = Math.max(5000, Math.min(400000, Math.round(4000 * Math.sqrt(tvl / 1e6))));
  const expected = (implied * 0.07) / farmers;
  const net = expected - gas;
  const p10 = (implied * 0.03) / (farmers * 2) - gas;
  const p90 = (implied * 0.12) / (farmers * 0.5) - gas;
  const verdict = net > 50 ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP';
  return { capital, gas, holdDays, farmers, expected, net, p10, p90, verdict };
}

export function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function fmtSigned2(n: number): string {
  return (n < 0 ? '-' : '+') + '$' + Math.abs(n).toFixed(2);
}

function categoryAction(category: string | null, name: string, capital: number, chain: string): string {
  const c = '$' + capital;
  switch (category) {
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'CDP':
    case 'CDP Manager':
    case 'Collateral Markets':
    case 'Leveraged Farming':
    case 'Interest Rate Derivatives':
      return `Lend ${c} of stablecoins into ${name} on ${chain}: open the ${name} app, connect the fresh wallet, deposit the ${c} into its main lending market and keep the receipt transaction. This is the qualifying deposit; do it once, in one transaction, and confirm it lands in your position.`;
    case 'Dexs':
    case 'Liquidity Manager':
      return `Provide ${c} of liquidity on ${name} on ${chain}: pair the deposit with the pool's other side, add it in one transaction, and keep the LP position open. One deposit of ${c} is the qualifying action; check the pool shows your share before you leave.`;
    case 'Yield':
    case 'Yield Aggregator':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Basis Trading':
    case 'CeDeFi':
      return `Deposit ${c} into ${name}'s main vault on ${chain} in one transaction and leave the receipt tokens in the fresh wallet. This single ${c} deposit is the qualifying action; confirm the vault shows your balance before you move on.`;
    case 'Staking Pool':
    case 'Restaking':
      return `Stake ${c} through ${name} on ${chain} in one transaction and keep the staking receipt in the fresh wallet. This single ${c} stake is the qualifying action; confirm your staked balance shows before you move on.`;
    case 'Derivatives':
      return `Open a ${c} position on ${name} on ${chain} with low leverage, then close it after the position registers on your account. The ${c} position is the qualifying action; keep the trade size at ${c} and do not add to it.`;
    case 'Prediction Market':
      return `Place ${c} across two outcomes on ${name} on ${chain} so the position registers, then leave the position open. The ${c} of prediction-market exposure is the qualifying action; keep it at ${c} total and do not chase losses.`;
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Wrapper':
      return `Mint or hold ${c} of ${name}'s stable asset on ${chain} in one transaction and keep it in the fresh wallet. This ${c} position is the qualifying action; confirm the balance shows on ${name} before you move on.`;
    case 'RWA':
      return `Buy ${c} of ${name}'s tokenised real-world asset on ${chain} in one transaction and hold it in the fresh wallet. This ${c} purchase is the qualifying action; confirm the position shows in your wallet before you move on.`;
    case 'Insurance':
      return `Buy ${c} of cover from ${name} on ${chain} in one transaction and keep the policy in the fresh wallet. This ${c} cover purchase is the qualifying action; confirm the policy shows as active before you move on.`;
    case 'Payments':
    case 'Crypto Card Issuer':
    case 'OTC Marketplace':
      return `Spend ${c} through ${name} on ${chain} in one transaction and keep the receipt. This ${c} payment is the qualifying action; confirm it settles on ${name} before you move on.`;
    case 'Farm':
      return `Deposit ${c} into ${name}'s main farm on ${chain} in one transaction and leave the LP or receipt tokens staked. This ${c} deposit is the qualifying action; confirm the farm shows your stake before you move on.`;
    case 'Indexes':
      return `Buy ${c} of ${name}'s index token on ${chain} in one transaction and hold it in the fresh wallet. This ${c} purchase is the qualifying action; confirm the index balance shows before you move on.`;
    case 'Chain':
    case 'Cross Chain Bridge':
      return `Bridge ${c} onto ${name} via its official bridge and hold the funds on ${chain} in the fresh wallet. This ${c} bridge is the qualifying action; confirm the balance arrives on ${chain} before you move on.`;
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return `Lock ${c} of BTC exposure through ${name} on ${chain} in one transaction and keep the receipt in the fresh wallet. This ${c} position is the qualifying action; confirm the locked balance shows before you move on.`;
    default:
      return `Deposit ${c} into ${name}'s main product on ${chain} in one transaction and keep the receipt in the fresh wallet. This ${c} deposit is the qualifying action; confirm the position shows on ${name} before you move on.`;
  }
}

export function farmSteps(p: Protocol, implied: number, asOf: string): { steps: string[]; math: FarmMath } {
  const math = farmMath(p, implied, asOf);
  const chain = p.chains[0] ?? 'Ethereum';
  const topup = Math.max(10, Math.round(math.capital / 10));
  const verdictLine =
    math.verdict === 'FARM'
      ? 'worth farming at this size'
      : math.verdict === 'THIN'
        ? 'thin — only farm it if you already use ' + p.name
        : 'skip — the expected value does not cover gas, so do not spend the $' + math.capital;
  const steps = [
    `Set aside 15 minutes: create a fresh wallet used only for ${p.name}, back up its seed phrase offline, and fund it with $${math.capital} plus $${math.gas} for gas on ${chain}.`,
    categoryAction(p.category, p.name, math.capital, chain),
    `Once a week, repeat the qualifying action with a small top-up of about $${topup} on ${chain} — about 10 minutes each week. Keep all activity in the same fresh wallet so the history stays on one address.`,
    `Hold the position untouched for ${math.holdDays} days from the first deposit. Do not withdraw, unstake or move the funds during the hold — early exits can reset eligibility — and check the position once a week, about 5 minutes.`,
    `When ${p.name} opens a points or rewards claim, claim only from its own points or rewards page linked in the app — never from a link in a chat, email or social post. Expect the claim to cost a few dollars of gas on ${chain}.`,
    `Net: expected ${fmtSigned2(math.net)} per farmer after $${math.gas} gas (P10 ${fmtSigned2(math.p10)} to P90 ${fmtSigned2(math.p90)}) — verdict ${math.verdict}: ${verdictLine}.`,
  ];
  return { steps, math };
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  watchlist: boolean;
  rank: number;
  implied_value_usd: number;
  net_usd: number;
  verdict: string;
  farmers: number;
  expected_usd: number;
  p10_usd: number;
  p90_usd: number;
  capital_usd: number;
  gas_usd: number;
  hold_days: number;
  farm_steps: string[];
  member_log: { ols: number; lad: number; neighbours: number; baseline: number; ensemble: number };
}

export function buildBoard(snap: Snapshot, pipe: Pipeline): BoardRow[] {
  const watch = new Set(snap.watchlist);
  const rows: BoardRow[] = [];
  for (const p of snap.protocols) {
    if (!isPreToken(p) || !passesBoardRule(p)) continue;
    const f = features(p, snap.as_of);
    const m = memberLogs(pipe, f);
    const implied = impliedFromLog(m.ensemble);
    const { steps, math } = farmSteps(p, implied, snap.as_of);
    rows.push({
      slug: p.slug,
      name: p.name,
      category: f.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p.listed_at, snap.as_of),
      watchlist: watch.has(p.slug),
      rank: 0,
      implied_value_usd: implied,
      net_usd: math.net,
      verdict: math.verdict,
      farmers: math.farmers,
      expected_usd: math.expected,
      p10_usd: math.p10,
      p90_usd: math.p90,
      capital_usd: math.capital,
      gas_usd: math.gas,
      hold_days: math.holdDays,
      farm_steps: steps,
      member_log: { ols: m.ols, lad: m.lad, neighbours: m.neighbours, baseline: m.baseline, ensemble: m.ensemble },
    });
  }
  rows.sort((a, b) => b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  rows.forEach((r, i) => {
    r.rank = i + 1;
  });
  return rows;
}

/** The 24 live-token protocols with the largest market caps, at the market's
 *  own value — the comparables the board is priced from, not board rows. */
export function topLive24(snap: Snapshot): Array<{
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  age_days: number;
}> {
  return snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category ?? 'Unknown',
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      age_days: ageDays(p.listed_at, snap.as_of),
    }));
}

// ---------------------------------------------------------------- gate check

export function gateCheck(board: { rows: BoardRow[] }, snap: Snapshot): void {
  const rows = board.rows;
  if (rows.length < 100 || rows.length > 4000) throw new Error(`gate: ${rows.length} rows, want 100-4000`);
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  const ranks = new Set<number>();
  let prev = Infinity;
  for (const r of rows) {
    if (!slugs.has(r.slug)) throw new Error(`gate: row slug ${r.slug} is not a snapshot protocol`);
    if (seen.has(r.slug)) throw new Error(`gate: duplicate slug ${r.slug}`);
    seen.add(r.slug);
    if (!Number.isInteger(r.rank) || r.rank < 1 || r.rank > rows.length) throw new Error(`gate: bad rank ${r.rank}`);
    ranks.add(r.rank);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14) {
      throw new Error(`gate: bad implied value for ${r.slug}`);
    }
    if (r.implied_value_usd > prev) throw new Error(`gate: implied value rises at rank ${r.rank}`);
    prev = r.implied_value_usd;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      throw new Error(`gate: ${r.slug} has ${r.farm_steps.length} farm steps`);
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) throw new Error(`gate: ${r.slug} farm step of ${t.length} chars`);
    }
  }
  if (ranks.size !== rows.length) throw new Error('gate: ranks are not exactly 1..N');
  for (const w of snap.watchlist) {
    if (!seen.has(w)) throw new Error(`gate: watchlist slug ${w} missing from the board`);
  }
  if (rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) {
    throw new Error('gate: all implied values are equal');
  }
}

// ---------------------------------------------------------------- assembly

export interface ModelSummary {
  liveCount: number;
  boardRows: number;
  watchlistCount: number;
  aboveFloorRankable: number;
  belowFloorRankable: number;
  topSlug: string;
  topName: string;
  topImplied: number;
  topNet: number;
  counts: { FARM: number; THIN: number; SKIP: number };
  weights: [number, number, number];
  olsBeta: number[];
  ladBeta: number[];
  oos: OosTable;
  bootstrap: BootstrapResult;
  growthTilt: GrowthTiltResult;
}

export interface BuildResult {
  board: { generated_by: string; as_of: string; rows: BoardRow[] };
  data: Record<string, unknown>;
  summary: ModelSummary;
}

export function buildAll(snap: Snapshot): BuildResult {
  const live = livePoints(snap);
  const pipe = fitPipeline(live);
  const oos = crossValidate(live);
  const boot = bootstrap(live);
  const growthTilt = fitGrowthTilt(internalOos(live));
  const rows = buildBoard(snap, pipe);
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of rows) counts[r.verdict as 'FARM' | 'THIN' | 'SKIP']++;
  const top = rows[0];
  const aboveFloor = rows.filter((r) => r.tvl_usd >= snap.floor_usd).length;
  const summary: ModelSummary = {
    liveCount: live.length,
    boardRows: rows.length,
    watchlistCount: snap.watchlist.length,
    aboveFloorRankable: aboveFloor,
    belowFloorRankable: rows.length - aboveFloor,
    topSlug: top.slug,
    topName: top.name,
    topImplied: top.implied_value_usd,
    topNet: top.net_usd,
    counts,
    weights: pipe.weights,
    olsBeta: pipe.ols.beta,
    ladBeta: pipe.lad.beta,
    oos,
    bootstrap: boot,
    growthTilt,
  };
  const data: Record<string, unknown> = {
    meta: {
      as_of: snap.as_of,
      floor_usd: snap.floor_usd,
      live_count: live.length,
      board_rows: rows.length,
      watchlist_count: snap.watchlist.length,
      weights: pipe.weights,
      ols_beta: pipe.ols.beta,
      lad_beta: pipe.lad.beta,
      ols_cat: pipe.ols.catEffect,
      lad_cat: pipe.lad.catEffect,
      baseline_global: pipe.base.global,
      baseline_by_cat: pipe.base.byCat,
      oos,
      bootstrap: boot,
      counts,
      top: { slug: top.slug, name: top.name, implied: top.implied_value_usd, net: top.net_usd },
      growth_tilt: growthTilt,
    },
    rows,
    live24: topLive24(snap),
    live: live.map((p) => ({ slug: p.slug, category: p.category, lnTvl: p.lnTvl, ratio: p.ratio })),
  };
  return { board: { generated_by: 'radar-3', as_of: snap.as_of, rows }, data, summary };
}
