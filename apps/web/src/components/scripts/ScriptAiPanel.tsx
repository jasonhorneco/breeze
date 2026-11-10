import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Undo2, Redo2 } from 'lucide-react';
import { useScriptAiStore } from '@/stores/scriptAiStore';
import { fetchWithAuth } from '@/stores/auth';
import { ModelPickerControl } from '@/components/ai/AiModelPicker';
import type { AiModelChoicesDto, OfferingOptions } from '@breeze/shared';
import ScriptAiMessages from './ScriptAiMessages';
import ScriptAiInput from './ScriptAiInput';
import type { ScriptFormBridge } from '@/stores/scriptAiStore';

interface ScriptAiPanelProps {
  bridge: ScriptFormBridge;
}

export default function ScriptAiPanel({ bridge }: ScriptAiPanelProps) {
  const { t } = useTranslation('scripts');
  const [modelChoices, setModelChoices] = useState<AiModelChoicesDto | null>(null);
  const {
    closePanel,
    sessionId,
    modelSelection,
    setModelSelection,
    isLoading,
    closeSession,
    interruptResponse,
    setBridge,
    hasApplied,
    hasReverted,
    revert,
    redo,
    error,
    clearError,
  } = useScriptAiStore();

  // Register the form bridge
  useEffect(() => {
    setBridge(bridge);
    return () => setBridge(null);
  }, [bridge, setBridge]);

  // A session starts on the first message so the chosen model can be bound at creation.
  useEffect(() => {
    const abort = new AbortController();
    void fetchWithAuth('/ai/models/choices/script-builder', { signal: abort.signal })
      .then(async response => response.ok ? await response.json() as { data: AiModelChoicesDto } : null)
      .then(result => {
        if (!abort.signal.aborted) setModelChoices(result?.data ?? null);
      })
      .catch(() => {
        if (!abort.signal.aborted) setModelChoices(null);
      });
    return () => abort.abort();
  }, []);

  const offeringId = modelSelection?.offeringId ?? modelChoices?.defaultOfferingId ?? null;
  const modelOptions = modelSelection?.options ?? modelChoices?.choices.find(choice => choice.offeringId === offeringId)?.defaults ?? {};

  function selectModel(id: string) {
    const choice = modelChoices?.choices.find(model => model.offeringId === id && !model.disabled);
    if (choice) setModelSelection({ offeringId: id, options: { ...choice.defaults } });
  }

  function setModelOption<K extends keyof OfferingOptions>(key: K, value: OfferingOptions[K] | undefined) {
    if (!offeringId) return;
    const options = { ...modelOptions };
    if (value === undefined) delete options[key];
    else options[key] = value;
    setModelSelection({ offeringId, options });
  }

  // Cleanup session on unmount — interrupt first if streaming
  useEffect(() => {
    return () => {
      const { isStreaming } = useScriptAiStore.getState();
      if (isStreaming) {
        interruptResponse().then(() => closeSession()).catch((err) => console.warn('[ScriptAiPanel] Cleanup failed:', err));
      } else {
        closeSession().catch((err) => console.warn('[ScriptAiPanel] Cleanup failed:', err));
      }
    };
  }, [closeSession, interruptResponse]);

  return (
    <div className="flex u-h-px-600 w-96 shrink-0 flex-col overflow-hidden border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{t('scriptAiPanel.title')}</span>
        <div className="flex items-center gap-1">
          {hasReverted && (
            <button
              type="button"
              onClick={redo}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              title={t('scriptAiPanel.actions.redoTitle')}
            >
              <Redo2 className="h-3 w-3" />
              {t('scriptAiPanel.actions.redo')}
            </button>
          )}
          {hasApplied && (
            <button
              type="button"
              onClick={revert}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
              title={t('scriptAiPanel.actions.revertTitle')}
            >
              <Undo2 className="h-3 w-3" />
              {t('scriptAiPanel.actions.revert')}
            </button>
          )}
          <button
            type="button"
            onClick={closePanel}
            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-destructive">{error}</p>
            <button onClick={clearError} className="text-xs text-destructive hover:underline">
              {t('scriptAiPanel.actions.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <ScriptAiMessages />

      {/* Input */}
      <ModelPickerControl choices={modelChoices} select={selectModel} setOption={setModelOption}
        value={{ offeringId, options: modelOptions }} disabled={Boolean(sessionId) || isLoading} />
      <ScriptAiInput />
    </div>
  );
}
