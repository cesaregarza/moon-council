import {
  PERSONALITY_PRESETS,
  sha256Hex,
  type PersonalityPreset,
  type PersonalityProfile,
} from "@werewolf/contracts";

/**
 * A seat's personality (CES-1585): none, a preset profile, or a custom profile edited from one.
 * Editing the text keeps the base profile's traits and motivations and records it in `basedOn`.
 */
export function PersonalityInput({
  name,
  value,
  onChange,
}: {
  name: string;
  value: PersonalityProfile | undefined;
  onChange: (value: PersonalityProfile | undefined) => void;
}) {
  const preset = value?.source.kind === "preset" ? value.id : value ? "custom" : "";
  const edit = (text: string) => {
    if (!value) return;
    const basedOn = value.source.kind === "custom" ? value.source.basedOn : value.id;
    onChange({
      ...value,
      id: "custom",
      label: `Custom (based on ${basedOn})`,
      text,
      source: { kind: "custom", basedOn },
      textSha256: sha256Hex(text),
    });
  };
  return (
    <>
      <select
        className="personality-preset"
        aria-label={`${name} personality preset`}
        value={preset}
        onChange={(event) => {
          const key = event.target.value;
          onChange(key ? PERSONALITY_PRESETS[key as PersonalityPreset] : undefined);
        }}
      >
        <option value="">No personality</option>
        {preset === "custom" ? <option value="custom">{value!.label}</option> : null}
        {Object.entries(PERSONALITY_PRESETS).map(([key, item]) => (
          <option key={key} value={key}>
            {item.label}
          </option>
        ))}
      </select>
      <textarea
        className="seat-personality"
        aria-label={`${name} personality`}
        value={value?.text ?? ""}
        maxLength={2000}
        disabled={!value}
        placeholder="Choose a personality to edit its text (40 to 200 words)"
        onChange={(event) => edit(event.target.value)}
      />
    </>
  );
}
