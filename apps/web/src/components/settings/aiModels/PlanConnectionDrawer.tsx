import { useState } from 'react';
import type { AiConnectionDto } from '@breeze/shared';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import { Drawer } from '../../shared/Drawer';
import { showToast } from '../../shared/Toast';

export default function PlanConnectionDrawer({ connection, modelCount, onClose, onSaved }: {
  connection: AiConnectionDto;
  modelCount: number;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/models/connections/${connection.id}/refresh`, { method: 'POST' }),
        successMessage: 'ChatGPT account models refreshed.',
        errorFallback: 'Could not refresh ChatGPT account models.',
      });
      await onSaved();
    } catch (error) {
      if (!(error instanceof ActionError)) showToast({ type: 'error', message: 'Could not refresh ChatGPT account models.' });
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Drawer open onClose={onClose} title="OpenAI Codex" dataTestId="ai-connection-drawer" closeDisabled={refreshing}>
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
        <p className="font-medium">Sign in with ChatGPT</p>
        <p>Uses your ChatGPT subscription. {modelCount} account models available.</p>
        <a className="text-primary underline" href="https://chatgpt.com/#settings/Usage" target="_blank" rel="noreferrer">
          Manage ChatGPT usage
        </a>
      </div>
      <div className="flex justify-end border-t px-5 py-4">
        <button type="button" data-testid="ai-connection-refresh" disabled={refreshing || !connection.id}
          className="rounded-md border px-3 py-1.5 text-sm" onClick={() => void refresh()}>
          {refreshing ? 'Refreshing models…' : 'Refresh models'}
        </button>
      </div>
    </Drawer>
  );
}
