import {
  MOTIVATION_KEYS,
  PERSONALITY_PRESETS,
  PersonalityProfileSchema,
  TRAIT_KEYS,
  seededPersonalityValues,
  sha256Hex,
  type PersonalityProfile,
  type PersonalityValues,
} from "@werewolf/contracts";

/**
 * CES-1585: generated personalities. A seed gives the trait and motivation values; a generator
 * turns them into the text a seat reads. The generator sees numbers only (and a preset name when
 * rewriting one), never a role, seat or game fact. Strange combinations are kept as drawn.
 */
export interface GeneratorInput extends PersonalityValues {
  presetName?: string;
}
export interface PersonalityGenerator {
  /** Recorded in each profile's source; "mock" for the deterministic test generator. */
  model: string;
  /** The instructions the generator follows; their hash is recorded in each profile. */
  prompt: string;
  generate(input: GeneratorInput): Promise<{ label: string; text: string }>;
}

/** Exactly the numbers (and an optional preset name): nothing else can reach a generator. */
export function generatorInput(values: PersonalityValues, presetName?: string): GeneratorInput {
  return {
    traits: Object.fromEntries(
      TRAIT_KEYS.map((key) => [key, values.traits[key]]),
    ) as GeneratorInput["traits"],
    motivations: Object.fromEntries(
      MOTIVATION_KEYS.map((key) => [key, values.motivations[key]]),
    ) as GeneratorInput["motivations"],
    ...(presetName ? { presetName } : {}),
  };
}

export const GENERATOR_PROMPT = [
  "Write a private personality file for a character in a social deduction game, from the numbers given.",
  "Traits run 0 to 1: deception, independence, conflict, risk, infoSeeking, selfPreservation, revisability, engagement.",
  "Motivations are weights summing to 1: team, survival, attention, chaos.",
  "Write in the second person, 60 to 150 words, describing how this character behaves and what it wants.",
  "Keep every extreme and contradiction exactly as the numbers say; do not make the character reasonable, cooperative or balanced.",
  "You know nothing about the game's roles, players or state, and must not mention any.",
  'Return only JSON: {"label": a short name, 2 to 5 words, "text": the personality file}.',
].join(" ");

const band = (value: number, low: string, mid: string, high: string) =>
  value < 0.34 ? low : value < 0.67 ? mid : high;

/** The test generator: a fixed template over the numbers, labeled mock everywhere. */
export const mockGenerator: PersonalityGenerator = {
  model: "mock",
  prompt: "mock-template-v1",
  async generate({ traits: t, motivations: m }) {
    const top = [...MOTIVATION_KEYS].sort((a, b) => m[b] - m[a])[0]!;
    const text = [
      "Mock personality from numbers only.",
      band(
        t.deception,
        "You almost never lie.",
        "You lie when it is useful.",
        "You lie freely and often.",
      ),
      band(
        t.independence,
        "You follow the group.",
        "You sometimes break from the group.",
        "You go your own way, whatever the group thinks.",
      ),
      band(t.conflict, "You avoid conflict.", "You argue when you must.", "You seek out conflict."),
      band(t.risk, "You play it safe.", "You take measured risks.", "You take big risks."),
      band(
        t.infoSeeking,
        "You rarely ask questions.",
        "You ask some questions.",
        "You hunt for information constantly.",
      ),
      band(
        t.selfPreservation,
        "You don't care whether you survive.",
        "You would like to survive.",
        "You guard your own life closely.",
      ),
      band(
        t.revisability,
        "You rarely change your mind.",
        "You change your mind sometimes.",
        "You change your mind easily.",
      ),
      band(t.engagement, "You say very little.", "You speak a fair amount.", "You talk a lot."),
      `What you want most is ${top}.`,
    ].join(" ");
    return { label: "Mock personality", text };
  },
};

/** A frozen generated profile for a seed: the seeded values, the generator's text, and hashes. */
export async function generatedProfile(
  seed: string,
  generator: PersonalityGenerator,
  createdAt: string,
): Promise<PersonalityProfile> {
  const values = seededPersonalityValues(seed);
  const { label, text } = await generator.generate(generatorInput(values));
  const mock = generator.model === "mock";
  const id = `${mock ? "mock" : "gen"}-${seed}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40);
  return PersonalityProfileSchema.parse({
    id,
    label: mock ? `Mock ${seed}` : label,
    ...values,
    text,
    source: {
      kind: "generated",
      seed,
      valuesSha256: sha256Hex(JSON.stringify(values)),
      generator: { model: generator.model, promptSha256: sha256Hex(generator.prompt) },
      createdAt,
    },
    textSha256: sha256Hex(text),
  });
}

/** The committed sample pool: the five v1 presets, then three mock profiles from fixed seeds. */
export async function samplePersonalityPool(): Promise<PersonalityProfile[]> {
  const presets = (
    ["liar", "maverick", "sacrificial-lamb", "disruptor", "careful-reasoner"] as const
  ).map((id) => PERSONALITY_PRESETS[id]);
  const mocks: PersonalityProfile[] = [];
  for (const seed of ["sample-1", "sample-2", "sample-3"])
    mocks.push(await generatedProfile(seed, mockGenerator, "2026-10-28T00:00:00.000Z"));
  return [...presets, ...mocks];
}
