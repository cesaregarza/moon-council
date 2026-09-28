import { PERSONALITY_PRESETS, type PersonalityPreset } from "@werewolf/contracts";

export function PersonalityInput({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const preset =
    Object.entries(PERSONALITY_PRESETS).find(([, item]) => item.text === value)?.[0] ?? "";
  return (
    <>
      <select
        aria-label={`${name} personality preset`}
        value={preset}
        onChange={(event) => {
          const key = event.target.value as PersonalityPreset;
          if (key) onChange(PERSONALITY_PRESETS[key].text);
        }}
      >
        <option value="">Custom personality</option>
        {Object.entries(PERSONALITY_PRESETS).map(([key, item]) => (
          <option key={key} value={key}>
            {item.label}
          </option>
        ))}
      </select>
      <textarea
        aria-label={`${name} personality`}
        value={value}
        maxLength={1000}
        placeholder="Optional personality override"
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}
