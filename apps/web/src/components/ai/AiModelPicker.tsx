import { useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EFFORT_LEVELS, type AiModelChoicesDto, type AiReviewProviderDto, type EffortLevel, type OfferingOptions } from '@breeze/shared';
import { useAiModelPickerStore } from '@/stores/aiModelPickerStore';
import { useAiStore } from '@/stores/aiStore';
import { formatCentsPerM, formatContextTokens } from './modelPickerFormat';
import ModelProviderSelect from './ModelProviderSelect';

const NO_ALTERNATIVES: string[] = [];

export function AlertReviewModelPicker({ catalog, value, onChange, disabled }: {
  catalog: AiReviewProviderDto;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2">
      <span>Model</span>
      <select aria-label="Alert review model" className="rounded border bg-background px-2 py-1"
        value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value={catalog.model.slug}>{catalog.provider} · {catalog.model.displayName} (Low)</option>
      </select>
    </label>
  );
}

/** Spec §11 "Chat composer": model menu + the options the chosen model supports. */
export default function AiModelPicker({ disabled }: { disabled?: boolean }) {
  const { choices, select, setOption, effective } = useAiModelPickerStore();
  const refusalAlternatives = useAiStore((s) => s.refusalAlternatives ?? NO_ALTERNATIVES);
  return <ModelPickerControl choices={choices} select={select} setOption={setOption} value={effective()}
    refusalAlternatives={refusalAlternatives} disabled={disabled} />;
}

export function ModelPickerControl({ choices, select, setOption, value, disabled, refusalAlternatives = NO_ALTERNATIVES }: {
  choices: AiModelChoicesDto | null;
  select: (offeringId: string) => void;
  setOption: <K extends keyof OfferingOptions>(key: K, value: OfferingOptions[K] | undefined) => void;
  value: { offeringId: string | null; options: OfferingOptions };
  disabled?: boolean;
  refusalAlternatives?: readonly string[];
}) {
  const { t } = useTranslation('ai');
  const [open, setOpen] = useState(false);
  if (!choices) return null;
  const standardChoices = choices.allowUserChoice ? choices.choices : [];
  const review = choices.reviewProvider;
  if (standardChoices.length === 0 && !review) return null;

  const { offeringId, options } = value;
  const chosen = standardChoices.find((c) => c.offeringId === offeringId) ?? null;
  const providerChoices = standardChoices.flatMap(choice => choice.provider && !choice.disabled
    ? [{ id: choice.offeringId, provider: choice.provider.id, label: choice.provider.name }] : []);
  const visibleModels = chosen?.provider
    ? standardChoices.filter(choice => choice.provider?.id === chosen.provider?.id) : standardChoices;

  return (
    <div className="relative flex flex-wrap items-center gap-2 border-t px-3 pt-2 text-xs" data-testid="ai-model-picker">
      <ModelProviderSelect choices={providerChoices} selected={offeringId ?? ''} onSelect={select}
        testId="ai-model-provider" disabled={disabled} />
      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid="ai-model-picker-button"
          className="flex items-center gap-1 rounded border px-2 py-1 hover:bg-muted disabled:opacity-50"
        >
          {chosen?.displayName ?? (standardChoices.length === 0 && review ? review.provider : t('aiModelPicker.chooseModel'))}
          <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <ul role="listbox" className="absolute bottom-full left-3 right-3 z-20 mb-1 max-h-72 max-w-80 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
            {visibleModels.map((c) => {
              const context = formatContextTokens(c.contextTokens);
              const price = c.funding === 'chatgpt_plan' ? 'OpenAI Codex · ChatGPT subscription' : t('aiModelPicker.price', {
                input: formatCentsPerM(c.priceHint.inputCentsPerM),
                output: formatCentsPerM(c.priceHint.outputCentsPerM),
              });
              const gated = c.disabled !== null;
              return (
                <li
                  key={c.offeringId}
                  role="option"
                  aria-selected={c.offeringId === offeringId}
                  aria-disabled={gated}
                  data-testid={`ai-model-option-${c.offeringId}`}
                  onClick={() => { if (!gated) { select(c.offeringId); setOpen(false); } }}
                  className={`flex cursor-pointer flex-col rounded px-2 py-1.5 ${gated ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted'}`}
                >
                  <span className="flex items-center gap-1 font-medium">
                    {gated && <Lock className="h-3 w-3" />}
                    {c.displayName}
                    {c.offeringId === choices.defaultOfferingId && (
                      <span className="text-muted-foreground">{t('aiModelPicker.default')}</span>
                    )}
                    {refusalAlternatives.includes(c.offeringId) && (
                      <span className="rounded bg-primary/10 px-1 text-primary">{t('aiModelPicker.suggested')}</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {[context ? t('aiModelPicker.context', { size: context }) : null, price].filter(Boolean).join(' · ')}
                  </span>
                  {gated && (
                    <span className="text-muted-foreground">
                      {c.disabled!.roleNames.length > 0
                        ? t('aiModelPicker.requiresRole', { roles: c.disabled!.roleNames.join(', ') })
                        : t('aiModelPicker.requiresPermission')}
                    </span>
                  )}
                </li>
              );
            })}
            {review && (
              <li role="option" aria-disabled="true" aria-selected="false" data-testid="ai-model-option-codex-review"
                className="flex flex-col rounded px-2 py-1.5 text-muted-foreground">
                <span>{review.provider} · {review.model.displayName}</span>
                <span>ChatGPT subscription · Alert review only</span>
              </li>
            )}
          </ul>
        )}
      </div>
      {open && review && <a className="underline" href={`/alerts/${review.alertId}`}>Open Codex alert review</a>}

      {chosen && chosen.options.effort.length > 0 && (
        <label className="flex items-center gap-1">
          {t('aiModelPicker.effort')}
          <select
            disabled={disabled}
            value={options.effort ?? ''}
            onChange={(e) => setOption('effort', (e.target.value || undefined) as EffortLevel | undefined)}
            data-testid="ai-model-effort"
            className="rounded border bg-background px-1 py-0.5"
          >
            <option value="">{t('aiModelPicker.effortDefault')}</option>
            {EFFORT_LEVELS.filter((e) => chosen.options.effort.includes(e)).map((e) => (
              <option key={e} value={e}>{t(/* i18n-dynamic */ `aiModelPicker.effortLevels.${e}`, { defaultValue: e })}</option>
            ))}
          </select>
        </label>
      )}

      {chosen && chosen.options.speed.includes('fast') && chosen.priceHint.fast && (
        <label className="flex items-center gap-1" data-testid="ai-model-fast">
          <input
            type="checkbox"
            disabled={disabled}
            checked={options.speed === 'fast'}
            onChange={(e) => setOption('speed', e.target.checked ? 'fast' : 'standard')}
          />
          {t('aiModelPicker.fast', {
            input: formatCentsPerM(chosen.priceHint.fast.inputCentsPerM),
            output: formatCentsPerM(chosen.priceHint.fast.outputCentsPerM),
          })}
        </label>
      )}

      {chosen && chosen.options.budgetThinking && (
        <label className="flex items-center gap-1" data-testid="ai-model-thinking">
          <input
            type="checkbox"
            disabled={disabled}
            checked={options.budgetThinking === 'on'}
            onChange={(e) => setOption('budgetThinking', e.target.checked ? 'on' : 'off')}
          />
          {t('aiModelPicker.thinking')}
        </label>
      )}
    </div>
  );
}
