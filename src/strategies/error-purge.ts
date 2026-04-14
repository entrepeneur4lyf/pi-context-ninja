export function shouldPurgeError(
  errorTurnIndex: number,
  currentTurn: number,
  maxTurnsAgo: number,
): boolean {
  return currentTurn - errorTurnIndex > maxTurnsAgo;
}

export function makeErrorTombstone(maxTurnsAgo: number): string {
  return `[Error output removed -- tool failed more than ${maxTurnsAgo} turns ago]`;
}
