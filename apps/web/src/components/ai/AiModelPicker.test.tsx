import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AiModelPicker from './AiModelPicker';
import { useAiModelPickerStore } from '@/stores/aiModelPickerStore';
import type { AiModelChoicesDto } from '@breeze/shared';

const base: AiModelChoicesDto = {
  surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def', current: { offeringId: 'def', options: null },
  choices: [
    { offeringId: 'def', displayName: 'Sonnet 5.5', contextTokens: 1_000_000, funding: 'platform',
      priceHint: { inputCentsPerM: 300, outputCentsPerM: 1500, fast: null }, thinkingMode: 'adaptive',
      options: { effort: ['low', 'medium', 'high'], speed: ['standard'], budgetThinking: false }, defaults: { effort: 'medium' }, disabled: null },
    { offeringId: 'opus', displayName: 'Opus 5.5', contextTokens: 1_000_000, funding: 'platform',
      priceHint: { inputCentsPerM: 500, outputCentsPerM: 2500, fast: { inputCentsPerM: 1000, outputCentsPerM: 5000 } }, thinkingMode: 'adaptive',
      options: { effort: ['low', 'high', 'max'], speed: ['standard', 'fast'], budgetThinking: false }, defaults: {},
      disabled: { reason: 'permission_required', permission: 'ai_models:premium', roleNames: ['Senior Tech'] } },
    { offeringId: 'haiku', displayName: 'Haiku 4.5', contextTokens: 200_000, funding: 'platform',
      priceHint: { inputCentsPerM: 100, outputCentsPerM: 500, fast: null }, thinkingMode: 'budget',
      options: { effort: [], speed: ['standard'], budgetThinking: true }, defaults: {}, disabled: null },
  ],
};

function setChoices(c: AiModelChoicesDto | null) {
  useAiModelPickerStore.setState({ choices: c, selection: null, loading: false });
}

beforeEach(() => useAiModelPickerStore.getState().reset());

describe('AiModelPicker (spec §11)', () => {
  it('changes models and supported efforts when OpenAI Codex is the selected provider', () => {
    const local = { ...base.choices[0]!, provider: { id: 'local', name: 'Existing provider' } };
    const luna = {
      ...local, offeringId: 'luna', displayName: 'GPT-6-Luna', funding: 'chatgpt_plan' as const,
      provider: { id: 'codex', name: 'OpenAI Codex' },
    };
    const sol = {
      ...luna, offeringId: 'sol', displayName: 'GPT-6.1-Sol',
      options: { ...luna.options, effort: ['low', 'ultra'] as Array<'low' | 'ultra'> },
      defaults: { effort: 'low' as const },
    };
    setChoices({ ...base, choices: [local, luna, sol] });
    render(<AiModelPicker />);
    fireEvent.change(screen.getByTestId('ai-model-provider'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    expect(screen.queryByTestId('ai-model-option-def')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-model-option-sol'));
    fireEvent.change(screen.getByTestId('ai-model-effort'), { target: { value: 'ultra' } });
    expect(useAiModelPickerStore.getState().pendingChoice()).toEqual({ offeringId: 'sol', options: { effort: 'ultra' } });
  });

  it('lists each offering with name, context size and price hint', () => {
    setChoices(base);
    render(<AiModelPicker />);
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    const def = screen.getByTestId('ai-model-option-def');
    expect(def.textContent).toContain('Sonnet 5.5');
    expect(def.textContent).toContain('1M');
    expect(def.textContent).toContain('$3');
    expect(def.textContent).toContain('$15');
  });
  it('a permission-gated offering is disabled with "requires <role>"', () => {
    setChoices(base);
    render(<AiModelPicker />);
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    const opus = screen.getByTestId('ai-model-option-opus');
    expect(opus).toHaveAttribute('aria-disabled', 'true');
    expect(opus.textContent).toContain('Senior Tech');
  });
  it('shows only the options the selected model supports: effort for adaptive, thinking for budget', () => {
    setChoices(base);
    render(<AiModelPicker />);
    expect(screen.getByTestId('ai-model-effort')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-model-thinking')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    fireEvent.click(screen.getByTestId('ai-model-option-haiku'));
    expect(screen.queryByTestId('ai-model-effort')).toBeNull();
    expect(screen.getByTestId('ai-model-thinking')).toBeInTheDocument();
  });
  it('Fast shows its higher rate, and only where Fast is selectable', () => {
    setChoices({ ...base, choices: base.choices.map((c) => (c.offeringId === 'opus' ? { ...c, disabled: null } : c)) });
    render(<AiModelPicker />);
    expect(screen.queryByTestId('ai-model-fast')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    fireEvent.click(screen.getByTestId('ai-model-option-opus'));
    expect(screen.getByTestId('ai-model-fast').textContent).toContain('$10');
  });
  it('everything is hidden when the surface is locked', () => {
    setChoices({ ...base, allowUserChoice: false, choices: [] });
    const { container } = render(<AiModelPicker />);
    expect(container).toBeEmptyDOMElement();
  });
  it('shows the real review catalog even when chat choice is locked, without selecting it', () => {
    setChoices({
      ...base, allowUserChoice: false, choices: [],
      reviewProvider: {
        provider: 'OpenAI Codex', funding: 'ChatGPT subscription',
        model: { slug: 'gpt-6-luna', displayName: 'GPT-6-Luna', effort: 'low' },
        verifiedAt: '2026-11-09T06:00:00Z', alertId: 'example-alert',
      },
    });
    render(<AiModelPicker />);
    fireEvent.click(screen.getByTestId('ai-model-picker-button'));
    const review = screen.getByTestId('ai-model-option-codex-review');
    expect(review).toHaveAttribute('aria-disabled', 'true');
    expect(review).toHaveTextContent('OpenAI Codex · GPT-6-Luna');
    expect(screen.getByRole('link', { name: 'Open Codex alert review' })).toHaveAttribute('href', '/alerts/example-alert');
    fireEvent.click(review);
    expect(useAiModelPickerStore.getState().selection).toBeNull();
  });
  it('is disabled while a reply streams (switch only between turns)', () => {
    setChoices(base);
    render(<AiModelPicker disabled />);
    expect(screen.getByTestId('ai-model-picker-button')).toBeDisabled();
  });
});
