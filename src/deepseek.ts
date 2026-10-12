/** DeepSeek Chat Completions API 的最小客户端。 */

export interface DeepSeekUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface DeepSeekResult {
  requestId: string | null;
  model: string;
  content: string;
  finishReason: string | null;
  usage: DeepSeekUsage;
}

interface DeepSeekResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface DeepSeekClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface DeepSeekPrompt {
  system: string;
  user: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function createDeepSeekClient(options: DeepSeekClientOptions): {
  extractJson(prompt: DeepSeekPrompt): Promise<DeepSeekResult>;
} {
  const apiKey = options.apiKey.trim();
  const model = options.model?.trim() || 'deepseek-flash';
  const baseUrl = trimTrailingSlash(options.baseUrl?.trim() || 'https://api.deepseek.com');
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');

  return {
    async extractJson(prompt: DeepSeekPrompt): Promise<DeepSeekResult> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            response_format: { type: 'json_object' },
            temperature: 0,
            max_tokens: 4096,
            stream: false,
          }),
        });

        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}）：${responseText.slice(0, 500)}`);
        }

        let data: DeepSeekResponse;
        try {
          data = JSON.parse(responseText) as DeepSeekResponse;
        } catch {
          throw new Error('DeepSeek API 返回了无法解析的响应');
        }

        const choice = data.choices?.[0];
        const content = choice?.message?.content?.trim() ?? '';
        if (!content) {
          if (attempt === 0) continue;
          throw new Error('DeepSeek API 连续两次返回空内容');
        }
        if (choice?.finish_reason === 'length') {
          throw new Error('DeepSeek 输出因长度限制被截断，请减少单次对话内容或提高 max_tokens');
        }

        return {
          requestId: data.id ?? null,
          model: data.model ?? model,
          content,
          finishReason: choice?.finish_reason ?? null,
          usage: {
            promptTokens: data.usage?.prompt_tokens ?? null,
            completionTokens: data.usage?.completion_tokens ?? null,
            totalTokens: data.usage?.total_tokens ?? null,
          },
        };
      }
      throw new Error('DeepSeek API 返回了空内容');
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