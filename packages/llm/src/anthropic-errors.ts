import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** Application provenance: set only alongside sanitized text, never taken from a provider body. */
export const CLAUDE_ERROR_FEEDBACK_VERSION = 1;

/** Only known transient transport causes justify another separately admitted request. */
const TRANSIENT_CAUSES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const SAFE_CAUSES = new Set([
  ...TRANSIENT_CAUSES,
  "ENOTFOUND",
  "EACCES",
  "EPERM",
  "ABORT_ERR",
  "UND_ERR_ABORTED",
  "ERR_CANCELED",
  "ECANCELED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_INVALID_URL",
]);
const TERMINAL_API_TYPES = new Set([
  "authentication_error",
  "permission_error",
  "billing_error",
  "invalid_request_error",
]);

/** No messages, names supplied by arbitrary errors, headers, IDs or request/response bodies. */
export interface ClaudeErrorDiagnostics {
  errorClass: string;
  status: number | null;
  causeCode: string | null;
  aborted: boolean;
  /** Request/SDK timeout; a lower-level socket timeout may precede the request deadline. */
  timedOut: boolean;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Follow ordinary Error.cause links only, with both depth and cycle bounds. */
function causes(error: unknown): unknown[] {
  const result: unknown[] = [];
  while (error && typeof error === "object" && result.length < 8 && !result.includes(error)) {
    result.push(error);
    error = ownValue(error, "cause");
  }
  return result;
}

function causeCode(chain: unknown[]): string | null {
  for (const value of chain) {
    const code = ownValue(value, "code");
    if (typeof code === "string") return SAFE_CAUSES.has(code) ? code : null;
  }
  return null;
}

function hasName(value: unknown, name: "AbortError" | "TimeoutError"): boolean {
  return ownValue(value, "name") === name || (value instanceof DOMException && value.name === name);
}

function errorClass(error: unknown): string {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return "APIConnectionTimeoutError";
  if (error instanceof Anthropic.APIUserAbortError) return "APIUserAbortError";
  if (error instanceof Anthropic.APIConnectionError) return "APIConnectionError";
  if (error instanceof Anthropic.RateLimitError) return "RateLimitError";
  if (error instanceof Anthropic.AuthenticationError) return "AuthenticationError";
  if (error instanceof Anthropic.PermissionDeniedError) return "PermissionDeniedError";
  if (error instanceof Anthropic.APIError) return "APIError";
  if (hasName(error, "AbortError")) return "AbortError";
  if (hasName(error, "TimeoutError")) return "TimeoutError";
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return error instanceof Error ? "Error" : "Unknown";
}

export function claudeErrorDiagnostics(
  error: unknown,
  signal?: AbortSignal,
): ClaudeErrorDiagnostics {
  const chain = causes(error);
  const api = chain.find((value) => value instanceof Anthropic.APIError);
  const status = api?.status;
  const code = causeCode(chain);
  return {
    errorClass: errorClass(error),
    status:
      typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : null,
    causeCode: code,
    aborted:
      Boolean(signal?.aborted) ||
      chain.some(
        (value) => value instanceof Anthropic.APIUserAbortError || hasName(value, "AbortError"),
      ) ||
      code === "ABORT_ERR" ||
      code === "UND_ERR_ABORTED" ||
      code === "ERR_CANCELED" ||
      code === "ECANCELED",
    timedOut:
      chain.some(
        (value) =>
          value instanceof Anthropic.APIConnectionTimeoutError || hasName(value, "TimeoutError"),
      ) ||
      Boolean(
        signal?.aborted &&
        (hasName(signal.reason, "TimeoutError") ||
          ownValue(signal.reason, "message") === "request timeout"),
      ),
  };
}

/** Unknown connection causes fail closed; HTTP retry behavior stays bounded by the same loop. */
export function retryableClaudeError(
  error: unknown,
  signal: AbortSignal,
): error is InstanceType<typeof Anthropic.APIError> {
  const diagnostic = claudeErrorDiagnostics(error, signal);
  if (diagnostic.aborted || diagnostic.timedOut) return false;
  if (error instanceof Anthropic.APIConnectionError)
    return diagnostic.causeCode !== null && TRANSIENT_CAUSES.has(diagnostic.causeCode);
  return (
    error instanceof Anthropic.APIError &&
    !TERMINAL_API_TYPES.has(error.type ?? "") &&
    typeof error.status === "number" &&
    (error.status === 429 || error.status >= 500)
  );
}

const FEEDBACK_FIELDS = new Set(
  "task memory journalUpdate decisionBrief action attention text speech acts kind targetId claim evidence respondsTo rationale mode choiceHandles reconsiderationQuestion urge ready plan listen beliefs hypotheses strategyUpdate questionsUpdate deceptionUpdate attentionUpdate playerId basis sources confidence observations alternatives id description advantage drawback selectedAlternativeId proposal summary journalPatch op value control question reason speakerIntent willingnessToListen wantsToSpeak silenceCase".split(
    " ",
  ),
);
const DECODE_FEEDBACK = new Set([
  "A journal update cannot contain speech",
  "A speech task requires speech",
  "Decision brief changes belong in journal_update",
  "Journal changes belong in journal_update",
  "Listening-note replacement belongs in journal_update",
  "Journal update is missing newly delivered evidence",
  "Missing authorized journal revision",
]);

function feedbackPath(path: PropertyKey[]): string {
  return (
    path
      .slice(0, 8)
      .map((part) => {
        if (
          typeof part === "number" &&
          Number.isSafeInteger(part) &&
          part >= 0 &&
          part <= 1_000_000
        )
          return `[${part}]`;
        if (typeof part === "string" && FEEDBACK_FIELDS.has(part)) return part;
        return "[field]";
      })
      .join(".") || "$"
  );
}

function feedbackBound(value: number | bigint): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
    ? String(value)
    : null;
}

function schemaIssueFeedback(issue: z.core.$ZodIssue): string {
  const path = feedbackPath(issue.path);
  if (issue.code === "too_big" || issue.code === "too_small") {
    const maximum = issue.code === "too_big";
    const bound = feedbackBound(maximum ? issue.maximum : issue.minimum);
    const unit =
      issue.origin === "string" ? "characters" : issue.origin === "array" ? "items" : "value";
    const comparison = maximum
      ? issue.inclusive
        ? "at most"
        : "less than"
      : issue.inclusive
        ? "at least"
        : "more than";
    return bound === null
      ? `${path}: violates a schema size constraint`
      : `${path}: must contain ${comparison} ${bound} ${unit}`;
  }
  if (issue.code === "invalid_type") {
    const expected = [
      "string",
      "number",
      "boolean",
      "object",
      "array",
      "null",
      "undefined",
      "int",
      "never",
    ].includes(issue.expected)
      ? issue.expected
      : "the schema type";
    return `${path}: expected ${expected}`;
  }
  if (issue.code === "unrecognized_keys") return `${path}: remove unexpected fields`;
  if (issue.code === "invalid_value") return `${path}: use an allowed schema value`;
  if (issue.code === "invalid_format") return `${path}: use the required schema format`;
  if (issue.code === "invalid_union") return `${path}: match a supplied schema alternative`;
  return `${path}: violates a schema constraint`;
}

/** Build repair feedback from constraints, never Zod messages, values, unknown keys or inputs. */
function schemaFeedback(error: z.ZodError): string {
  const issues = error.issues.slice(0, 4).map(schemaIssueFeedback).join("; ");
  const more =
    error.issues.length > 4 ? `; ${error.issues.length - 4} additional schema issues` : "";
  return `Claude response failed schema validation: ${issues}${more}`;
}

/**
 * Shared diagnostic-text boundary for attempts, events and repair prompts. SDK messages may
 * contain response bodies; generic messages and legacy stored strings are equally untrusted.
 * Only explicitly known local decode instructions and structured schema constraints survive.
 */
export function claudeErrorText(error: unknown, signal?: AbortSignal): string {
  if (error instanceof z.ZodError) return schemaFeedback(error);
  if (error instanceof SyntaxError)
    return "Claude response was not valid JSON; return a complete JSON object matching the supplied schema";
  if (!(error instanceof Anthropic.AnthropicError)) {
    const message = ownValue(error, "message");
    if (typeof message === "string") {
      if (DECODE_FEEDBACK.has(message)) return message;
      const mismatch =
        /^Expected API response task (journal_update|discussion_free_speech|closing_response), received (journal_update|discussion_free_speech|closing_response)$/.exec(
          message,
        );
      if (mismatch) return `Expected API response task ${mismatch[1]}, received ${mismatch[2]}`;
    }
  }
  const diagnostic = claudeErrorDiagnostics(error, signal);
  return `Claude request failed (${diagnostic.errorClass}; status=${diagnostic.status ?? "unknown"}; cause=${diagnostic.causeCode ?? "unknown"}; aborted=${diagnostic.aborted}; timedOut=${diagnostic.timedOut})`;
}
