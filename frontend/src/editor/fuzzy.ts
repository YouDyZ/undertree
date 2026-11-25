export interface FuzzyResult {
  score: number;
  matchedIndices: number[];
}

const BOUNDARY_CHARS = new Set(["\\", "{", "}", "[", "]", "_", "-", ":", "/", ".", " ", "*"]);

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

function isWordBoundary(target: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = target[index - 1] ?? "";
  const curr = target[index] ?? "";
  if (BOUNDARY_CHARS.has(prev)) return true;
  if (isLower(prev) && isUpper(curr)) return true;
  return false;
}

const BASE_MATCH = 10;
const CONSECUTIVE_BONUS = 18;
const BOUNDARY_BONUS = 12;
const EXACT_CASE_BONUS = 2;
const START_BONUS = 6;
const AFTER_BACKSLASH_BONUS = 5;
const GAP_PENALTY = 3;
const LEADING_OFFSET_PENALTY = 0.5;
const LENGTH_PENALTY = 0.15;
const EXACT_MATCH_BONUS = 40;
const PREFIX_MATCH_BONUS = 25;

/**
 * Case-insensitive subsequence fuzzy matcher with DP-optimal scoring.
 * Rewards exact prefixes, consecutive runs, word/symbol boundaries, and shorter targets;
 * penalizes large gaps.
 */
export function fuzzyMatch(query: string, target: string): FuzzyResult | null {
  if (query.length === 0) {
    return { score: 0, matchedIndices: [] };
  }
  if (query.length > target.length) {
    return null;
  }

  const qLower = query.toLowerCase();
  const tLower = target.toLowerCase();
  const qLen = qLower.length;
  const tLen = tLower.length;

  // Fast subsequence rejection before allocating DP buffers
  {
    let qi = 0;
    for (let ti = 0; ti < tLen && qi < qLen; ti++) {
      if (tLower[ti] === qLower[qi]) qi++;
    }
    if (qi < qLen) return null;
  }

  const bonusAt = (qi: number, ti: number): number => {
    let s = BASE_MATCH;
    if (query[qi] === target[ti]) s += EXACT_CASE_BONUS;
    if (isWordBoundary(target, ti)) s += BOUNDARY_BONUS;
    if (qi === 0) {
      if (ti === 0) {
        s += START_BONUS;
      } else if (ti === 1 && target[0] === "\\") {
        s += AFTER_BACKSLASH_BONUS;
      } else {
        const effectiveOffset = target[0] === "\\" ? ti - 1 : ti;
        s -= effectiveOffset * LEADING_OFFSET_PENALTY;
      }
    }
    return s;
  };

  let matchedIndices: number[];
  let bestScore: number;

  if (qLen <= 64 && tLen <= 256) {
    // O(qLen * tLen) DP finding the globally highest-scoring subsequence alignment
    const NEG_INF = -1e9;
    const match = new Float64Array(qLen * tLen);
    const prevIdx = new Int16Array(qLen * tLen);
    match.fill(NEG_INF);
    prevIdx.fill(-1);

    // Row 0
    for (let j = 0; j < tLen; j++) {
      if (tLower[j] === qLower[0]) {
        match[j] = bonusAt(0, j);
      }
    }

    // Subsequent rows
    for (let i = 1; i < qLen; i++) {
      const rowOffset = i * tLen;
      const prevRowOffset = (i - 1) * tLen;
      const qCh = qLower[i];

      // Track best non-consecutive predecessor score (adjusted with linear gap penalty)
      // bestGapScore represents max_{k <= j-2} (match[i-1][k] - (j - k - 1) * GAP_PENALTY)
      let bestGapScore = NEG_INF;
      let bestGapK = -1;

      for (let j = i; j < tLen; j++) {
        if (j >= 2) {
          const candK = j - 2;
          const candScore = match[prevRowOffset + candK] ?? NEG_INF;
          const shiftedPrev = bestGapScore > NEG_INF / 2 ? bestGapScore - GAP_PENALTY : NEG_INF;
          const candWithGap = candScore > NEG_INF / 2 ? candScore - GAP_PENALTY : NEG_INF;
          if (candWithGap >= shiftedPrev) {
            bestGapScore = candWithGap;
            bestGapK = candK;
          } else {
            bestGapScore = shiftedPrev;
          }
        }

        if (tLower[j] !== qCh) continue;

        const cellBonus = bonusAt(i, j);
        const consecPrev = match[prevRowOffset + (j - 1)] ?? NEG_INF;
        const consecScore = consecPrev > NEG_INF / 2 ? consecPrev + CONSECUTIVE_BONUS : NEG_INF;
        const gapScore = bestGapScore;

        if (consecScore >= gapScore && consecScore > NEG_INF / 2) {
          match[rowOffset + j] = consecScore + cellBonus;
          prevIdx[rowOffset + j] = j - 1;
        } else if (gapScore > NEG_INF / 2) {
          match[rowOffset + j] = gapScore + cellBonus;
          prevIdx[rowOffset + j] = bestGapK;
        }
      }
    }

    // Find best ending column in last row
    const lastRow = (qLen - 1) * tLen;
    bestScore = NEG_INF;
    let endCol = -1;
    for (let j = qLen - 1; j < tLen; j++) {
      const val = match[lastRow + j] ?? NEG_INF;
      if (val > bestScore) {
        bestScore = val;
        endCol = j;
      }
    }
    if (endCol < 0) return null;

    matchedIndices = new Array<number>(qLen);
    let col = endCol;
    for (let i = qLen - 1; i >= 0; i--) {
      matchedIndices[i] = col;
      col = prevIdx[i * tLen + col] ?? -1;
    }
  } else {
    // Linear fallback for unusually long targets/queries
    matchedIndices = [];
    bestScore = 0;
    let qi = 0;
    let prev = -1;
    for (let ti = 0; ti < tLen && qi < qLen; ti++) {
      if (tLower[ti] === qLower[qi]) {
        matchedIndices.push(ti);
        bestScore += bonusAt(qi, ti);
        if (prev >= 0) {
          if (ti === prev + 1) {
            bestScore += CONSECUTIVE_BONUS;
          } else {
            bestScore -= (ti - prev - 1) * GAP_PENALTY;
          }
        }
        prev = ti;
        qi++;
      }
    }
    if (qi < qLen) return null;
  }

  // Exact / prefix bonuses (also honoring optional leading backslash)
  const strippedTarget = tLower.startsWith("\\") ? tLower.slice(1) : tLower;
  if (tLower === qLower || strippedTarget === qLower) {
    bestScore += EXACT_MATCH_BONUS;
  } else if (tLower.startsWith(qLower) || strippedTarget.startsWith(qLower)) {
    bestScore += PREFIX_MATCH_BONUS;
  }

  // Slight preference for shorter candidates
  bestScore -= (tLen - qLen) * LENGTH_PENALTY;

  return {
    score: Math.round(bestScore * 100) / 100,
    matchedIndices,
  };
}

/**
 * Converts sorted matched character indices (e.g. [0, 1, 4, 5, 6])
 * into CodeMirror's [from, to, from, to, ...] highlight range array ([0, 2, 4, 7]).
 */
export function indicesToMatchRanges(indices: readonly number[], offset = 0): number[] {
  if (indices.length === 0) return [];
  const ranges: number[] = [];
  let start = (indices[0] ?? 0) + offset;
  let end = start + 1;
  for (let i = 1; i < indices.length; i++) {
    const idx = (indices[i] ?? 0) + offset;
    if (idx === end) {
      end = idx + 1;
    } else {
      ranges.push(start, end);
      start = idx;
      end = idx + 1;
    }
  }
  ranges.push(start, end);
  return ranges;
}
