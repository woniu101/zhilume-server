import { AppError } from "./domain.js";

export const protocols = [
  "chat-completions",
  "responses",
  "anthropic-messages",
];
export function providerEndpoint(value: unknown) {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new AppError("invalid_endpoint", "请输入有效的 API 根地址");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new AppError(
      "invalid_endpoint",
      "使用 HTTPS 根地址；本机服务可使用 HTTP。地址不能包含密钥或查询参数",
    );
  return url.href
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses|messages)$/, "");
}
export function providerHeaders(
  protocol: string,
  key: string,
): Record<string, string> {
  return protocol === "anthropic-messages"
    ? {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      }
    : { "Content-Type": "application/json", Authorization: "Bearer " + key };
}
export function providerRequest(
  spec: any,
  input: any,
  images: { mime: string; data: string }[],
) {
  const schema = input.schema,
    reasoning = spec.reasoningEffort || "default";
  if (spec.protocol === "responses")
    return {
      path: "/responses",
      body: {
        model: spec.model,
        stream: false,
        store: false,
        instructions: input.systemPrompt,
        max_output_tokens: spec.maxOutputTokens,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: input.text },
              ...images.map((i) => ({
                type: "input_image",
                image_url: `data:${i.mime};base64,${i.data}`,
                detail: "auto",
              })),
            ],
          },
        ],
        ...(reasoning !== "default"
          ? { reasoning: { effort: reasoning } }
          : {}),
        ...(schema
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "result",
                  strict: true,
                  schema,
                },
              },
            }
          : {}),
      },
    };
  if (spec.protocol === "anthropic-messages")
    return {
      path: "/messages",
      body: {
        model: spec.model,
        stream: false,
        system: input.systemPrompt,
        max_tokens: spec.maxOutputTokens,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: input.text },
              ...images.map((i) => ({
                type: "image",
                source: { type: "base64", media_type: i.mime, data: i.data },
              })),
            ],
          },
        ],
        ...(reasoning === "none" ? { thinking: { type: "disabled" } } : {}),
        ...(schema
          ? { output_config: { format: { type: "json_schema", schema } } }
          : {}),
      },
    };
  return {
    path: "/chat/completions",
    body: {
      model: spec.model,
      stream: false,
      max_tokens: spec.maxOutputTokens,
      ...(reasoning !== "default" ? { reasoning_effort: reasoning } : {}),
      messages: [
        { role: "system", content: input.systemPrompt },
        {
          role: "user",
          content: images.length
            ? [
                { type: "text", text: input.text },
                ...images.map((i) => ({
                  type: "image_url",
                  image_url: { url: `data:${i.mime};base64,${i.data}` },
                })),
              ]
            : input.text,
        },
      ],
      ...(schema
        ? {
            response_format:
              spec.structuredMode === "json_object"
                ? { type: "json_object" }
                : {
                    type: "json_schema",
                    json_schema: { name: "result", strict: true, schema },
                  },
          }
        : {}),
    },
  };
}
export function providerContent(protocol: string, result: any): string {
  const incomplete = () => {
    throw new AppError(
      "incomplete_output",
      "模型未完整输出或拒绝了请求，原稿未改变",
    );
  };
  if (protocol === "responses") {
    if (result.status !== "completed" || !Array.isArray(result.output))
      return incomplete();
    const messages = result.output.filter((x: any) => x.type === "message");
    if (
      messages.some(
        (x: any) =>
          x.status !== "completed" ||
          x.content?.some((c: any) => c.type === "refusal"),
      )
    )
      return incomplete();
    return messages
      .flatMap((x: any) => x.content || [])
      .filter((x: any) => x.type === "output_text")
      .map((x: any) => x.text)
      .join("\n");
  }
  if (protocol === "anthropic-messages") {
    if (result.stop_reason !== "end_turn" || !Array.isArray(result.content))
      return incomplete();
    return result.content
      .filter((x: any) => x.type === "text")
      .map((x: any) => x.text)
      .join("\n");
  }
  if (
    result.choices?.[0]?.finish_reason !== "stop" ||
    result.choices?.[0]?.message?.refusal
  )
    return incomplete();
  return result.choices?.[0]?.message?.content;
}
export async function boundedProviderJson(response: Response, limit = 256000) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      "provider_error",
      `模型服务返回 HTTP ${response.status}，请检查地址、权限和模型名称`,
    );
  }
  let raw = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body as any) {
    raw += decoder.decode(chunk, { stream: true });
    if (raw.length > limit)
      throw new AppError("output_too_large", "模型服务响应过大");
  }
  return JSON.parse(raw + decoder.decode());
}
