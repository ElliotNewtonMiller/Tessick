// Results recorded in Execute mode that a queue refresh may not include yet. A refresh sent
// before a result was saved (the window's focus event, say, just before `p`) answers with the
// case as it was; replacing the queue with that answer put the case back to U until the next
// refresh, although the server had the result. So the queue keeps what it shows for those cases.

/** One recorded result, from the optimistic update until its save is answered. */
export interface VerdictSave {
  testPlanCaseId: string;
  runId: string;
  /** The number of refreshes sent before the save was answered; null while it's saving. */
  savedAfterRefreshes: number | null;
}

export class UnsettledVerdicts {
  private refreshes = 0;
  private saves = new Map<string, VerdictSave>();

  /** A result was shown for this case (optimistically) and is being saved. */
  saving(testPlanCaseId: string, runId: string): VerdictSave {
    const save: VerdictSave = { testPlanCaseId, runId, savedAfterRefreshes: null };
    this.saves.set(testPlanCaseId, save);
    return save;
  }

  /** The server saved it: refreshes sent from now on include it. */
  saved(save: VerdictSave): void {
    if (this.saves.get(save.testPlanCaseId) === save) save.savedAfterRefreshes = this.refreshes;
  }

  /** It wasn't saved (and the queue put the case back): the server's answer is right. */
  failed(save: VerdictSave): void {
    if (this.saves.get(save.testPlanCaseId) === save) this.saves.delete(save.testPlanCaseId);
  }

  /** A refresh is being sent; returns its number, for unsettledIn. */
  refreshSent(): number {
    return ++this.refreshes;
  }

  /**
   * The cases of `runId` whose result refresh number `refresh` may not include: saved only after
   * it was sent, or still saving. Results it does include are forgotten.
   */
  unsettledIn(refresh: number, runId: string): Set<string> {
    const unsettled = new Set<string>();
    for (const [id, save] of this.saves) {
      if (save.savedAfterRefreshes !== null && save.savedAfterRefreshes < refresh) this.saves.delete(id);
      else if (save.runId === runId) unsettled.add(id);
    }
    return unsettled;
  }
}

type QueueCase = {
  test_plan_case_id: string;
  latest_verdict: string;
  latest_notes?: string | null;
  latest_test_result_id?: string | null;
};

/** The refreshed cases, keeping the result the queue shows for the unsettled ones. */
export function keepUnsettledResults<T extends QueueCase>(fresh: T[], shown: T[], unsettled: Set<string>): T[] {
  if (unsettled.size === 0) return fresh;
  const shownById = new Map(shown.map((c) => [c.test_plan_case_id, c]));
  return fresh.map((c) => {
    const kept = unsettled.has(c.test_plan_case_id) ? shownById.get(c.test_plan_case_id) : undefined;
    return kept
      ? { ...c, latest_verdict: kept.latest_verdict, latest_notes: kept.latest_notes, latest_test_result_id: kept.latest_test_result_id }
      : c;
  });
}
