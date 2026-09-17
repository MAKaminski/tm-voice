/**
 * The one line posted back to the meeting's channel once its commitments are on the board. It is
 * written here rather than in apps/capture because capture has already exited by the time there is
 * a task count to report — it hands off at the end of the recording and never learns the outcome.
 */
export function summaryLine(taskCount: number, durationSec: number, boardUrl: string): string {
  const mins = Math.max(1, Math.round(durationSec / 60));
  const tasks = taskCount === 1 ? "1 task" : `${taskCount} tasks`;
  return `Recording stopped after ${mins} min — filed ${tasks} to the board: ${boardUrl}`;
}
