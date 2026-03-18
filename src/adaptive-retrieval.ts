export interface AdaptiveRetrievalResult {
  shouldRetrieve: boolean;
  reason: string;
}

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;

const MEMORY_KEYWORDS_EN = [
  "remember",
  "recall",
  "previously",
  "before",
  "last time",
  "earlier",
  "history",
  "past",
  "mentioned",
  "discussed",
  "decided",
  "agreed",
  "preference",
  "forgot",
];

const MEMORY_KEYWORDS_ZH = [
  "记得",
  "记住",
  "之前",
  "上次",
  "以前",
  "历史",
  "过去",
  "提到",
  "讨论",
  "决定",
  "偏好",
  "忘了",
  "忘记",
];

const SKIP_PATTERNS = [
  /^\/\w+/,
  /^(?:y|n|yes|no|ok|okay|sure)$/i,
  /^[\p{Emoji}]+$/u,
  /^[.!?,;:]+$/,
];

const MIN_LENGTH_EN = 15;
const MIN_LENGTH_CJK = 6;

export function shouldRetrieve(query: string): AdaptiveRetrievalResult {
  const trimmed = query.trim();

  if (!trimmed) {
    return { shouldRetrieve: false, reason: "empty query" };
  }

  for (const p of SKIP_PATTERNS) {
    if (p.test(trimmed)) {
      return { shouldRetrieve: false, reason: "skip pattern match" };
    }
  }

  const lowerQuery = trimmed.toLowerCase();
  for (const kw of MEMORY_KEYWORDS_EN) {
    if (lowerQuery.includes(kw)) {
      return { shouldRetrieve: true, reason: `memory keyword: ${kw}` };
    }
  }

  for (const kw of MEMORY_KEYWORDS_ZH) {
    if (trimmed.includes(kw)) {
      return { shouldRetrieve: true, reason: `memory keyword: ${kw}` };
    }
  }

  const hasCJK = CJK_RANGE.test(trimmed);
  const minLength = hasCJK ? MIN_LENGTH_CJK : MIN_LENGTH_EN;

  if (trimmed.length < minLength) {
    return {
      shouldRetrieve: false,
      reason: `too short (${trimmed.length} < ${minLength})`,
    };
  }

  return { shouldRetrieve: true, reason: "passes all filters" };
}
