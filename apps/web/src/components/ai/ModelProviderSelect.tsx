interface Choice {
  id: string;
  provider: string;
  label: string;
}

export default function ModelProviderSelect({ choices, selected, onSelect, testId, disabled }: {
  choices: Choice[];
  selected: string;
  onSelect: (id: string) => void;
  testId: string;
  disabled?: boolean;
}) {
  const providers = new Map(choices.map(choice => [choice.provider, choice.label]));
  const selectedProvider = choices.find(choice => choice.id === selected)?.provider ?? '';
  if (providers.size === 0) return null;
  return (
    <label className="space-y-1 text-xs font-medium">
      <span>Provider</span>
      <select className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
        data-testid={testId} value={selectedProvider} disabled={disabled}
        onChange={event => {
          const choice = choices.find(model => model.provider === event.target.value);
          if (choice) onSelect(choice.id);
        }}>
        <option value="" disabled>Choose provider</option>
        {[...providers].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
  );
}
