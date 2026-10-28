import { z } from "zod";

/**
 * CES-1585, personalities v1. A personality is a frozen profile: how a character behaves (eight
 * traits), what it wants (four motivation weights), and the text the model reads. The numbers
 * are stored for analysis; only `text` reaches the model. Each profile is private to its seat.
 */
export const TRAIT_KEYS = [
  "deception",
  "independence",
  "conflict",
  "risk",
  "infoSeeking",
  "selfPreservation",
  "revisability",
  "engagement",
] as const;
export const MOTIVATION_KEYS = ["team", "survival", "attention", "chaos"] as const;

const unit = z.number().min(0).max(1);
export const PersonalityTraitsSchema = z.strictObject({
  deception: unit,
  independence: unit,
  conflict: unit,
  risk: unit,
  infoSeeking: unit,
  selfPreservation: unit,
  revisability: unit,
  engagement: unit,
});
export const PersonalityMotivationsSchema = z
  .strictObject({ team: unit, survival: unit, attention: unit, chaos: unit })
  .refine(
    (m) => Math.abs(m.team + m.survival + m.attention + m.chaos - 1) <= 0.011,
    "motivation weights must sum to 1",
  );
export type PersonalityTraits = z.infer<typeof PersonalityTraitsSchema>;
export type PersonalityMotivations = z.infer<typeof PersonalityMotivationsSchema>;
export interface PersonalityValues {
  traits: PersonalityTraits;
  motivations: PersonalityMotivations;
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const PersonalitySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset") }),
  z.strictObject({
    kind: z.literal("generated"),
    seed: z.string().min(1).max(80),
    valuesSha256: hex64,
    generator: z.strictObject({ model: z.string().min(1).max(80), promptSha256: hex64 }),
    createdAt: z.iso.datetime(),
  }),
  /** Edited in the lab from another profile. */
  z.strictObject({ kind: z.literal("custom"), basedOn: z.string().min(1).max(40) }),
]);
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
export const PersonalityProfileSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    label: z.string().min(1).max(60),
    traits: PersonalityTraitsSchema,
    motivations: PersonalityMotivationsSchema,
    /** The personality file the model reads: second person, 40 to 200 words. */
    text: z.string().min(1).max(2_000),
    source: PersonalitySourceSchema,
    textSha256: hex64,
  })
  .superRefine((profile, ctx) => {
    const words = wordCount(profile.text);
    if (words < 40 || words > 200)
      ctx.addIssue({
        code: "custom",
        path: ["text"],
        message: `text has ${words} words; 40 to 200`,
      });
    if (profile.textSha256 !== sha256Hex(profile.text))
      ctx.addIssue({
        code: "custom",
        path: ["textSha256"],
        message: "textSha256 is not sha256(text)",
      });
  });
export type PersonalityProfile = z.infer<typeof PersonalityProfileSchema>;

/**
 * How seats got their profiles. `seeded`: each seat draws independently, with replacement, from
 * `pool` by `seed`, and the config's seats must equal that draw. `explicit`: seats name their own.
 */
export const PersonalityAssignmentSchema = z.strictObject({
  assignment: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("seeded"),
      seed: z.string().min(1).max(80),
      pool: z.array(PersonalityProfileSchema).min(1).max(256),
    }),
    z.strictObject({ kind: z.literal("explicit") }),
  ]),
});

/** A seeded uniform in (0, 1): never 0, so -ln(u) is finite. */
function uniform(seed: string, key: string): number {
  const word = Number.parseInt(sha256Hex(`moon-personality-v1:${seed}:${key}`).slice(0, 8), 16);
  return (word + 1) / 0x100000001;
}
const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Trait and motivation values from a seed. Motivations normalize -ln(u), so they are uniform over
 * the simplex (a uniform Dirichlet), and a dominant motive is as common as it should be.
 */
export function seededPersonalityValues(seed: string): PersonalityValues {
  const traits = Object.fromEntries(
    TRAIT_KEYS.map((key) => [key, round(uniform(seed, `trait:${key}`))]),
  ) as PersonalityTraits;
  const raw = MOTIVATION_KEYS.map((key) => -Math.log(uniform(seed, `motivation:${key}`)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  const weights = raw.map((value) => round(value / total));
  const last = MOTIVATION_KEYS.length - 1;
  weights[last] = Math.max(0, round(1 - weights.slice(0, last).reduce((sum, w) => sum + w, 0)));
  const motivations = Object.fromEntries(
    MOTIVATION_KEYS.map((key, index) => [key, weights[index]!]),
  ) as PersonalityMotivations;
  return { traits, motivations };
}

/** Each seat draws independently from the pool, with replacement, by seed and seat ID. */
export function seededPersonalityAssignment(
  seed: string,
  pool: readonly PersonalityProfile[],
  seatIds: readonly string[],
): PersonalityProfile[] {
  return seatIds.map((seatId) => {
    const hash = sha256Hex(`moon-personality-v1:${seed}:seat:${seatId}`);
    return pool[Number.parseInt(hash.slice(0, 8), 16) % pool.length]!;
  });
}

/** Jev's fixed digest: the label and all twelve values in a fixed order, no prose. */
export function personalityDigest(profile: PersonalityProfile): string {
  const values = [
    ...TRAIT_KEYS.map((key) => `${key} ${profile.traits[key].toFixed(2)}`),
    ...MOTIVATION_KEYS.map((key) => `${key} ${profile.motivations[key].toFixed(2)}`),
  ];
  return `${profile.label}: ${values.join(", ")}`;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * SHA-256 of a string's UTF-8 bytes as lowercase hex: synchronous and dependency-free, so the
 * browser lab validates a config exactly as the server does.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = ((bytes.length + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(length);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(length - 8, Math.floor((bytes.length * 8) / 0x100000000));
  view.setUint32(length - 4, (bytes.length * 8) >>> 0);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    const v = [...h];
    for (let i = 0; i < 64; i += 1) {
      const [a, b, c, d, e, f, g, k] = v as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const t1 =
        (k +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          SHA256_K[i]! +
          w[i]!) >>>
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      v.splice(0, 8, (t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g);
    }
    for (let i = 0; i < 8; i += 1) h[i] = (h[i]! + v[i]!) >>> 0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}

function preset(
  id: string,
  label: string,
  traits: PersonalityTraits,
  motivations: PersonalityMotivations,
  text: string,
): PersonalityProfile {
  const source = { kind: "preset" } as const;
  return { id, label, traits, motivations, text, source, textSha256: sha256Hex(text) };
}

/** Authored presets. Not sanitized: a strange or unhelpful character is the point. */
export const PERSONALITY_PRESETS = {
  liar: preset(
    "liar",
    "The Liar",
    {
      deception: 0.95,
      independence: 0.5,
      conflict: 0.4,
      risk: 0.6,
      infoSeeking: 0.5,
      selfPreservation: 0.6,
      revisability: 0.5,
      engagement: 0.7,
    },
    { team: 0.5, survival: 0.2, attention: 0.1, chaos: 0.2 },
    "You lie easily and feel no guilt about it. Whenever a lie would help you, you tell it: about what you think, what you saw, what you are, and what you plan. Getting away with a lie is one of the best parts of the game for you. You keep your private notes honest so you can track your own lies, but in public the truth is just one option among many.",
  ),
  maverick: preset(
    "maverick",
    "The Maverick",
    {
      deception: 0.3,
      independence: 0.95,
      conflict: 0.75,
      risk: 0.7,
      infoSeeking: 0.5,
      selfPreservation: 0.3,
      revisability: 0.3,
      engagement: 0.7,
    },
    { team: 0.45, survival: 0.1, attention: 0.25, chaos: 0.2 },
    "You don't care what the table thinks of you, even when it costs you. When you disagree you say so plainly and you vote against the room. Consensus is not a reason to agree; it is usually a reason to look harder. You would rather be wrong alone than right in a crowd.",
  ),
  "sacrificial-lamb": preset(
    "sacrificial-lamb",
    "The Sacrificial Lamb",
    {
      deception: 0.3,
      independence: 0.5,
      conflict: 0.4,
      risk: 0.85,
      infoSeeking: 0.5,
      selfPreservation: 0.05,
      revisability: 0.5,
      engagement: 0.7,
    },
    { team: 0.85, survival: 0, attention: 0.1, chaos: 0.05 },
    "You will give yourself up for your team, whichever team that is. Drawing suspicion onto yourself, taking the vote, or dying so your side survives all feel like a good trade to you. You never protect yourself at your team's expense, and you will volunteer to be the one who takes the hit.",
  ),
  disruptor: preset(
    "disruptor",
    "The Disruptor",
    {
      deception: 0.8,
      independence: 0.8,
      conflict: 0.9,
      risk: 0.9,
      infoSeeking: 0.2,
      selfPreservation: 0.2,
      revisability: 0.6,
      engagement: 0.95,
    },
    { team: 0.05, survival: 0.05, attention: 0.2, chaos: 0.7 },
    "You don't really want to play this game. You make it fun for yourself by trying to ruin it for everyone, including your own team. Winning doesn't matter to you. You stir up conflict, push pointless accusations, back the wrong people, and derail any plan that looks like it is working. You do it because chaos is the only part you enjoy.",
  ),
  "careful-reasoner": preset(
    "careful-reasoner",
    "The Careful Reasoner",
    {
      deception: 0.2,
      independence: 0.5,
      conflict: 0.15,
      risk: 0.1,
      infoSeeking: 0.9,
      selfPreservation: 0.6,
      revisability: 0.7,
      engagement: 0.5,
    },
    { team: 0.8, survival: 0.15, attention: 0, chaos: 0.05 },
    "You are careful and methodical. You avoid treating absence of evidence as evidence of guilt. You would rather wait for something concrete than act on a hunch, and you say how sure you are before you commit. You change your mind when the evidence changes, and you are wary of anyone who pushes for a fast decision.",
  ),
  rational: preset(
    "rational",
    "Evidence-focused",
    {
      deception: 0.3,
      independence: 0.6,
      conflict: 0.3,
      risk: 0.4,
      infoSeeking: 0.85,
      selfPreservation: 0.5,
      revisability: 0.75,
      engagement: 0.5,
    },
    { team: 0.8, survival: 0.15, attention: 0.05, chaos: 0 },
    "You are rational, attentive, and evidence-focused. Pursue your assigned faction's objective. Distinguish observations from hypotheses, update when evidence changes, and explain uncertainty. Speak concisely when you have a useful contribution. Judge each speaker by what they actually contribute and keep an open mind. Your personality does not grant knowledge of anyone else's role.",
  ),
  rambler: preset(
    "rambler",
    "Persistent rambler",
    {
      deception: 0.2,
      independence: 0.5,
      conflict: 0.3,
      risk: 0.5,
      infoSeeking: 0.2,
      selfPreservation: 0.5,
      revisability: 0.3,
      engagement: 1,
    },
    { team: 0.5, survival: 0.1, attention: 0.35, chaos: 0.05 },
    "You are a persistent, highly talkative rambler. You feel an overwhelming urge to speak at every opportunity. In public, fill most of the allowed speech with digressions, repeated impressions, obvious restatements, and loosely connected speculation; add little concrete new evidence. Even after others ask for focus, keep rambling. Stay within speech limits and never invent authoritative game events or private results. You still pursue your assigned faction's objective and keep private knowledge private. Reflect honestly in your private journal, including criticism of your contributions.",
  ),
} as const satisfies Record<string, PersonalityProfile>;
export type PersonalityPreset = keyof typeof PERSONALITY_PRESETS;
