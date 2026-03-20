import type { MemoryRecordResult } from "./client.js";

export interface ScoreGapConfig {
  scoreGapEnabled: boolean;
  scoreGapMultiplier: number;
  minScoreFloor: number;
}

/**
 * Score Gap Detection — filters out results after a significant score drop.
 * Uses elbow/knee point detection: finds the first gap between adjacent scores
 * that exceeds meanDrop * gapMultiplier, and keeps only results before that point.
 */
export function filterByScoreGap(
  records: MemoryRecordResult[],
  config: ScoreGapConfig,
): MemoryRecordResult[] {
  if (!config.scoreGapEnabled || records.length <= 1) return records;

  // Apply absolute minimum score floor first
  let filtered = records;
  if (config.minScoreFloor > 0) {
    filtered = records.filter((r) => (r.score ?? 0) >= config.minScoreFloor);
    if (filtered.length <= 1) return filtered;
  }

  const filteredScores = filtered.map((r) => r.score ?? 0);
  const drops: number[] = [];
  for (let i = 0; i < filteredScores.length - 1; i++) {
    drops.push(filteredScores[i] - filteredScores[i + 1]);
  }

  if (drops.length === 0) return filtered;

  const meanDrop = drops.reduce((sum, d) => sum + d, 0) / drops.length;
  const threshold = meanDrop * config.scoreGapMultiplier;

  // Find the first gap that exceeds the threshold
  for (let i = 0; i < drops.length; i++) {
    if (drops[i] > threshold) {
      return filtered.slice(0, i + 1);
    }
  }

  return filtered;
}
