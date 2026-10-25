import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { claudeErrorDiagnostics, claudeErrorText, retryableClaudeError } from "./anthropic-errors";

const open = () => new AbortController().signal;
const connection = (code?: string) =>
  new Anthropic.APIConnectionError({
    cause: new TypeError("synthetic fetch detail", {
      cause: Object.assign(new Error("synthetic socket detail"), code ? { code } : {}),
    }),
  });

describe("classified Claude errors", () => {
  it.each([
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
  ])("retries the classified transient cause %s", (code) => {
    const error = connection(code);
    expect(retryableClaudeError(error, open())).toBe(true);
    expect(claudeErrorDiagnostics(error)).toEqual({
      errorClass: "APIConnectionError",
      status: null,
      causeCode: code,
      aborted: false,
      timedOut: false,
    });
  });

  it.each([
    undefined,
    "ENOTFOUND",
    "EACCES",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "unclassified-private-fixture",
  ])("does not retry an unknown or permanent cause (%s)", (code) => {
    expect(retryableClaudeError(connection(code), open())).toBe(false);
  });

  it("does not mistake an application TypeError for an SDK transport failure", () => {
    expect(
      retryableClaudeError(
        Object.assign(new TypeError("local failure"), { code: "ECONNRESET" }),
        open(),
      ),
    ).toBe(false);
  });

  it.each([400, 401, 402, 403, 422, 429, 500, 529])(
    "preserves bounded HTTP eligibility at status %i",
    (status) => {
      const error = Anthropic.APIError.generate(
        status,
        { type: "error", error: { type: "api_error", message: "synthetic" } },
        "synthetic",
        new Headers(),
      );
      expect(retryableClaudeError(error, open())).toBe(status === 429 || status >= 500);
      expect(claudeErrorDiagnostics(error).status).toBe(status);
    },
  );

  it.each(["authentication_error", "permission_error", "billing_error", "invalid_request_error"])(
    "does not retry terminal API type %s even with a retryable status",
    (type) => {
      const error = Anthropic.APIError.generate(
        529,
        { type: "error", error: { type, message: "synthetic terminal response" } },
        "synthetic",
        new Headers(),
      );
      expect(retryableClaudeError(error, open())).toBe(false);
    },
  );

  it("never retries after caller abort or deadline", () => {
    const error = connection("ECONNRESET");
    const aborted = AbortSignal.abort(new Error("synthetic caller cancellation"));
    const deadline = AbortSignal.abort(new DOMException("synthetic deadline", "TimeoutError"));
    expect(retryableClaudeError(error, aborted)).toBe(false);
    expect(claudeErrorDiagnostics(error, aborted)).toMatchObject({
      aborted: true,
      timedOut: false,
    });
    expect(retryableClaudeError(error, deadline)).toBe(false);
    expect(claudeErrorDiagnostics(error, deadline)).toMatchObject({
      aborted: true,
      timedOut: true,
    });
    expect(
      claudeErrorDiagnostics(error, AbortSignal.abort(new Error("request timeout"))).timedOut,
    ).toBe(true);
  });

  it.each([new Anthropic.APIUserAbortError(), new Anthropic.APIConnectionTimeoutError()])(
    "never retries an SDK cancellation or request timeout",
    (error) => {
      Object.assign(error, {
        cause: Object.assign(new Error("synthetic cause"), { code: "ECONNRESET" }),
      });
      expect(retryableClaudeError(error, open())).toBe(false);
    },
  );

  it("bounds cyclic causes and excludes arbitrary names, codes, messages, headers and bodies", () => {
    const marker = "private-diagnostic-fixture";
    const cause = Object.assign(new Error(marker), {
      name: marker,
      code: marker,
      headers: { authorization: marker },
      body: { prompt: marker },
    });
    Object.assign(cause, { cause });
    const diagnostics = claudeErrorDiagnostics(new Anthropic.APIConnectionError({ cause }));
    expect(diagnostics.causeCode).toBeNull();
    expect(Object.keys(diagnostics).sort()).toEqual([
      "aborted",
      "causeCode",
      "errorClass",
      "status",
      "timedOut",
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(marker);
  });

  it("does not invoke cause or code accessors", () => {
    const getter = vi.fn(() => {
      throw new Error("synthetic getter must not run");
    });
    const error = new Anthropic.APIConnectionError({});
    Object.defineProperty(error, "cause", { get: getter });
    Object.defineProperty(error, "code", { get: getter });
    expect(claudeErrorDiagnostics(error).causeCode).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not bypass an unclassified outer code to retry an inner transient cause", () => {
    const error = new Anthropic.APIConnectionError({
      cause: Object.assign(new Error("synthetic wrapper"), {
        code: "unknown-fixture-code",
        cause: Object.assign(new Error("synthetic nested cause"), { code: "ECONNRESET" }),
      }),
    });
    expect(retryableClaudeError(error, open())).toBe(false);
  });
});

describe("Claude diagnostic text privacy", () => {
  const marker = "synthetic-private-provider-diagnostic-marker";
  it.each([400, 429, 529, undefined])(
    "does not emit SDK messages, bodies, headers or cause messages (status %s)",
    (status) => {
      const error = new Anthropic.APIError(
        status,
        { message: marker },
        marker,
        new Headers({ "x-synthetic": marker }),
      );
      Object.assign(error, { cause: Object.assign(new Error(marker), { code: "ECONNRESET" }) });
      const text = claudeErrorText(error);
      expect(text).not.toContain(marker);
      expect(text).toContain("ECONNRESET");
      expect(text).toContain(`status=${status ?? "unknown"}`);
    },
  );

  it.each([
    new Anthropic.AnthropicError(marker),
    new Error(marker),
    new SyntaxError(marker),
    marker,
  ])("suppresses base-SDK, ordinary, syntax and primitive error text", (error) => {
    expect(claudeErrorText(error)).not.toContain(marker);
  });

  it("formats structural bounds but omits input values, unknown field names and custom messages", () => {
    const result = z
      .strictObject({ rationale: z.string().max(300), acts: z.array(z.string()).max(4) })
      .safeParse({
        rationale: marker.repeat(20),
        acts: ["a", "b", "c", "d", "e"],
        [marker]: marker,
      });
    if (result.success) throw new Error("Expected synthetic schema failure");
    const text = claudeErrorText(result.error);
    expect(text).toContain("rationale: must contain at most 300 characters");
    expect(text).toContain("acts: must contain at most 4 items");
    expect(text).toContain("remove unexpected fields");
    expect(text).not.toContain(marker);
    const custom = new z.ZodError([{ code: "custom", path: [marker], message: marker }]);
    expect(claudeErrorText(custom)).not.toContain(marker);
    expect(claudeErrorText(custom)).toContain("[field]");
  });

  it("keeps a known local decode instruction without trusting arbitrary suffixes", () => {
    const instruction = "A journal update cannot contain speech";
    expect(claudeErrorText(new Error(instruction))).toBe(instruction);
    expect(claudeErrorText(new Error(`${instruction}: ${marker}`))).not.toContain(marker);
    const http = new Anthropic.APIError(400, { message: instruction }, instruction, new Headers());
    expect(claudeErrorText(http)).toContain("status=400");
  });

  it("does not render schema enum values or record keys", () => {
    const result = z
      .object({ mode: z.literal(marker), listen: z.record(z.string(), z.number()) })
      .safeParse({ mode: "other", listen: { [marker]: marker } });
    if (result.success) throw new Error("Expected synthetic schema failure");
    expect(claudeErrorText(result.error)).not.toContain(marker);
    expect(claudeErrorText(result.error)).toContain("mode: use an allowed schema value");
  });
});

it("preserves only recognized task-mismatch keywords in local decode feedback", () => {
  const message = "Expected API response task journal_update, received discussion_free_speech";
  expect(claudeErrorText(new Error(message))).toBe(message);
  const marker = "synthetic-private-mismatch-marker";
  expect(claudeErrorText(new Error(`${message}: ${marker}`))).not.toContain(marker);
  expect(
    claudeErrorText(new Error(`Expected API response task journal_update, received ${marker}`)),
  ).not.toContain(marker);
  const sdk = new Anthropic.APIError(400, { message }, message, new Headers());
  expect(claudeErrorText(sdk)).toContain("status=400");
});
