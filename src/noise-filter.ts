export type NoiseCategory =
  | "greeting"
  | "heartbeat"
  | "slash_command"
  | "rejection"
  | "meta";

export interface NoiseFilterResult {
  isNoise: boolean;
  category?: NoiseCategory;
}

const GREETING_PATTERNS = [
  /^(?:hi|hello|hey|howdy|yo|sup|hola|greetings)[\s!.,]*$/i,
  /^(?:good\s+(?:morning|afternoon|evening|night))[\s!.,]*$/i,
  /^(?:你好|嗨|哈囉|早安|午安|晚安|嘿)[\s!.,]*$/,
  /^(?:thanks?|thank\s+you|thx|ty)[\s!.,]*$/i,
  /^(?:bye|goodbye|see\s+you|later|cya)[\s!.,]*$/i,
  /^(?:ok|okay|sure|yep|yes|no|nope|nah|y|n)[\s!.,]*$/i,
  /^(?:谢谢|感谢|好的|嗯|是的|不是|再见|掰掰)[\s!.,]*$/,
];

const HEARTBEAT_PATTERNS = [
  /^\.{1,3}$/,
  /^[\s\u200b]*$/,
  /^ping$/i,
  /^test$/i,
];

const SLASH_COMMAND_PATTERN = /^\/\w+/;

const REJECTION_PATTERNS_EN = [
  /^i don['']t have (?:any )?information/i,
  /^i(?:'m| am) (?:not )?(?:sure|able|capable)/i,
  /^i (?:cannot|can't|can not) (?:help|assist|do)/i,
  /^sorry,? i (?:don't|cannot|can't)/i,
  /^unfortunately,? i (?:don't|cannot|can't)/i,
  /^as an ai/i,
];

const REJECTION_PATTERNS_ZH = [
  /^(?:抱歉|对不起|不好意思)/,
  /^我(?:不|没有|无法)(?:知道|记得|了解|确定)/,
  /^很抱歉/,
];

const META_PATTERNS = [
  /^what (?:can|do) you/i,
  /^who are you/i,
  /^你(?:是谁|能做什么|会什么)/,
];

export function classifyNoise(text: unknown): NoiseFilterResult {
  if (typeof text !== "string") return { isNoise: false };
  const trimmed = text.trim();
  if (!trimmed) return { isNoise: true, category: "greeting" };

  if (SLASH_COMMAND_PATTERN.test(trimmed)) {
    return { isNoise: true, category: "slash_command" };
  }

  for (const p of HEARTBEAT_PATTERNS) {
    if (p.test(trimmed)) return { isNoise: true, category: "heartbeat" };
  }

  for (const p of GREETING_PATTERNS) {
    if (p.test(trimmed)) return { isNoise: true, category: "greeting" };
  }

  for (const p of META_PATTERNS) {
    if (p.test(trimmed)) return { isNoise: true, category: "meta" };
  }

  for (const p of [...REJECTION_PATTERNS_EN, ...REJECTION_PATTERNS_ZH]) {
    if (p.test(trimmed)) return { isNoise: true, category: "rejection" };
  }

  return { isNoise: false };
}

export function isNoise(text: unknown): boolean {
  return classifyNoise(text).isNoise;
}
