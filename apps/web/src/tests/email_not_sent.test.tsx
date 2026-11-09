// @vitest-environment jsdom
/**
 * An email that went nowhere -- captured because no mail server is set, or failed -- shows the
 * amber "not sent" warning, with no check mark, and it stays until dismissed (it used to be a
 * green "✓ Captured" note that the schedules tab cleared after 4 seconds).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { EmailReportDialog } from '../components/reports/EmailReportDialog';
import { SchedulesTab } from '../components/reports/SchedulesTab';
import { CAPTURED_NOT_SENT } from '../components/EmailSettingsPanel';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const schedule = {
  id: 'sch-1', name: 'Weekly health', sections: [{ kind: 'overview' }], recipients: ['qa@example.com'], message: null,
  frequency: 'WEEKLY', weekday: 1, time_of_day: '09:00', timezone: 'UTC', only_when_new_run: false, enabled: true,
  next_run_at: '2026-11-16T09:00:00.000Z', last_run_at: null, last_status: null, last_error: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('emails that were not sent', () => {
  it('Email this report: a captured email shows the amber warning, not a success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ email: { status: 'CAPTURED', error: null, subject: 'Overview', recipients: ['me@example.com'] } }, 201)));
    render(<EmailReportDialog projectId="prj-1" what="Overview" sections={[{ report_id: 'project_overview', params: {} }]} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/stakeholder@example.com/), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Email not sent');
    expect(alert.textContent).toContain(CAPTURED_NOT_SENT);
    expect(alert.textContent).not.toContain('✓');
  });

  it('Email this report: a failed send shows the same warning with the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ email: { status: 'FAILED', error: 'Connection refused', subject: 'Overview', recipients: ['me@example.com'] } }, 201)));
    render(<EmailReportDialog projectId="prj-1" what="Overview" sections={[{ report_id: 'project_overview', params: {} }]} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/stakeholder@example.com/), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Email not sent');
    expect(alert.textContent).toContain('Sending failed: Connection refused');
  });

  it('Scheduled emails: "Send now" with no mail server keeps the warning until OK', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/send-now')) return json({ status: 'CAPTURED', error: null });
      if (init?.method === undefined || init.method === 'GET') return json({ schedules: [schedule] });
      return json({});
    }));
    render(<SchedulesTab projectId="prj-1" plans={[]} defaultPlanId="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send now' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('"Weekly health" not sent');
    expect(alert.textContent).toContain(CAPTURED_NOT_SENT);
    expect(alert.textContent).not.toContain('✓');

    // Well past the 4-second notes, it's still there.
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole('alert')).toBe(alert);

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
