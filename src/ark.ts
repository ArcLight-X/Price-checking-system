/** 火山方舟 Responses API 的最小客户端。 */

export interface ArkUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ArkResult {
  requestId: string | null;
  model: string;
  content: string;
  finishReason: string | null;
  usage: ArkUsage;
}

interface ArkResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string | null } | null;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export interface ArkClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ArkPrompt {
  system: string;
  user: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readOutputText(data: ArkResponse): string {
  return (data.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('')
    .trim();
}

export function createArkClient(options: ArkClientOptions): {
  extractJson(prompt: ArkPrompt): Promise<ArkResult>;
} {
  const apiKey = options.apiKey.trim();
  const model = options.model?.trim() || 'doubao-seed-2-0-mini-260428';
  const baseUrl = trimTrailingSlash(options.baseUrl?.trim() || 'https://ark.cn-beijing.volces.com/api/v3');
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!apiKey) throw new Error('未配置 ARK_API_KEY');

  return {
    async extractJson(prompt: ArkPrompt): Promise<ArkResult> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetchImpl(`${baseUrl}/responses`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: prompt.system }] },
              { role: 'user', content: [{ type: 'input_text', text: prompt.user }] },
            ],
            max_output_tokens: 4096,
            stream: false,
          }),
        });

        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`火山方舟 API 请求失败（HTTP ${response.status}）：${responseText.slice(0, 500)}`);
        }

        let data: ArkResponse;
        try {
          data = JSON.parse(responseText) as ArkResponse;
        } catch {
          throw new Error('火山方舟 API 返回了无法解析的响应');
        }

        const content = readOutputText(data);
        if (!content) {
          if (attempt === 0) continue;
          throw new Error('火山方舟 API 连续两次返回空内容');
        }
        if (data.status === 'incomplete') {
          throw new Error(`豆包输出未完成：${data.incomplete_details?.reason ?? 'unknown'}`);
        }

        return {
          requestId: data.id ?? null,
          model: data.model ?? model,
          content,
          finishReason: data.status ?? null,
          usage: {
            promptTokens: data.usage?.input_tokens ?? null,
            completionTokens: data.usage?.output_tokens ?? null,
            totalTokens: data.usage?.total_tokens ?? null,
          },
        };
      }
      throw new Error('火山方舟 API 返回了空内容');
    },
  };
}

/** JSON 模式正常返回纯 JSON；顺带兼容模型偶尔包裹 Markdown 代码块的情况。 */
export function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(withoutFence) as unknown;
}