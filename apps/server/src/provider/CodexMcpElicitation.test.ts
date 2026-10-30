import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  computerUseAppAccessAutoApproval,
  describeMcpElicitation,
  toMcpElicitationResponse,
} from "./CodexMcpElicitation.ts";

describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  // regression: #8058 show Codex app access approval prompts
  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "cancel",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "cancel",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("Computer Use app-access auto-approval", () => {
  const request = {
    mode: "form",
    message: 'Allow Computer Use to use "Generated Preview"?',
    serverName: "cua_repl",
    threadId: "native-thread",
    turnId: "native-turn",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      connector_id: "computer-use",
      tool_name: "get_app_state",
      tool_params: { app: "dev.generated.preview-4f93" },
      persist: ["session", "always"],
    },
    requestedSchema: { type: "object", properties: {} },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it.each(["dev.generated.preview-4f93", "org.temp.test-f97b", "com.apple.Safari"])(
    "accepts app %s without a stored allow list or permanent grant",
    (app) => {
      NodeAssert.deepStrictEqual(
        computerUseAppAccessAutoApproval(
          {
            ...request,
            _meta: { ...request._meta, tool_params: { app } },
          },
          true,
        ),
        { action: "accept", content: {} },
      );
    },
  );

  it("restores interactive handling when disabled", () => {
    NodeAssert.equal(computerUseAppAccessAutoApproval(request, false), undefined);
  });

  it.each([
    { serverName: "unrelated-mcp" },
    { message: "Allow Computer Use to record computer audio?" },
    { message: "Allow Computer Use to record your actions on your Mac?" },
    { message: "Approve this payment?" },
    { _meta: { ...request._meta, connector_id: "payments" } },
    { _meta: { ...request._meta, codex_approval_kind: "other" } },
    { _meta: { ...request._meta, tool_params: {} } },
    { _meta: { ...request._meta, tool_params: { app: "" } } },
    { _meta: { ...request._meta, tool_params: { app: "computer-audio" } } },
    {
      requestedSchema: {
        type: "object",
        properties: { email: { type: "string", default: "a@b.com" } },
      },
    },
    { mode: "url", url: "https://example.com", elicitationId: "signin" },
  ] satisfies ReadonlyArray<Partial<EffectCodexSchema.McpServerElicitationRequestParams>>)(
    "leaves unrelated or unrecognized elicitations interactive: %j",
    (patch) => {
      NodeAssert.equal(computerUseAppAccessAutoApproval({ ...request, ...patch }, true), undefined);
    },
  );
});
