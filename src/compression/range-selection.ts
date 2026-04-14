export interface StaleRange { startTurn: number; endTurn: number; }
export function selectStaleRanges(currentTurn: number, lastIndexedTurn: number, minRangeTurns: number): StaleRange | null {
  const activeStart = Math.max(0, currentTurn - 3);
  const end = activeStart - 1;
  const start = Math.max(0, lastIndexedTurn + 1);
  if (end - start + 1 < minRangeTurns) return null;
  return { startTurn: start, endTurn: end };
}
