import { describe, it, expect } from 'vitest';
import { keepUnsettledResults, UnsettledVerdicts } from '../utils/unsettledVerdicts';

const queue = (verdicts: Record<string, string>) =>
  Object.entries(verdicts).map(([id, v]) => ({ test_plan_case_id: id, latest_verdict: v, latest_notes: null, latest_test_result_id: null }));

describe('UnsettledVerdicts', () => {
  it("keeps a result a refresh sent before it was saved doesn't have", () => {
    const u = new UnsettledVerdicts();
    // The window's focus event sends a refresh, then `p` records a pass.
    const refresh = u.refreshSent();
    const save = u.saving('pc1', 'run1');
    u.saved(save);
    // The refresh answers with the case untested: the queue keeps its pass.
    expect([...u.unsettledIn(refresh, 'run1')]).toEqual(['pc1']);
    const shown = queue({ pc1: 'PASSED', pc2: 'UNTESTED' });
    const fresh = queue({ pc1: 'UNTESTED', pc2: 'FAILED' });
    expect(keepUnsettledResults(fresh, shown, u.unsettledIn(refresh, 'run1')).map((c) => c.latest_verdict)).toEqual(['PASSED', 'FAILED']);

    // A refresh sent after the save includes it, and then it's forgotten.
    const later = u.refreshSent();
    expect(u.unsettledIn(later, 'run1').size).toBe(0);
    expect(u.unsettledIn(refresh, 'run1').size).toBe(0);
  });

  it('keeps a result still saving, whenever the refresh was sent', () => {
    const u = new UnsettledVerdicts();
    u.saving('pc1', 'run1');
    expect([...u.unsettledIn(u.refreshSent(), 'run1')]).toEqual(['pc1']);
  });

  it("trusts the server for a result that wasn't saved, or for another run", () => {
    const u = new UnsettledVerdicts();
    const refresh = u.refreshSent();
    u.failed(u.saving('pc1', 'run1'));
    u.saving('pc2', 'run1');
    expect([...u.unsettledIn(refresh, 'run2')]).toEqual([]);
    expect([...u.unsettledIn(refresh, 'run1')]).toEqual(['pc2']);
  });

  it("a case recorded again stays unsettled until its latest save is answered", () => {
    const u = new UnsettledVerdicts();
    const first = u.saving('pc1', 'run1');
    const second = u.saving('pc1', 'run1');
    u.saved(first); // the first answer comes back while the second is still saving
    expect([...u.unsettledIn(u.refreshSent(), 'run1')]).toEqual(['pc1']);
    u.saved(second);
    expect(u.unsettledIn(u.refreshSent(), 'run1').size).toBe(0);
  });
});
