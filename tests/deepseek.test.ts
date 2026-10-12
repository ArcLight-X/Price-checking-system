import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepSeekClient, parseModelJson } from '../src/deepseek.ts';

test('解析纯 JSON 和 Markdown JSON 代码块', () => {
  assert.deepEqual(parseModelJson('{"claims":[]}'), { claims: [] });
  assert.deepEqual(parseModelJson('```json\n{"claims":[]}\n```'), { claims: [] });
});

test('DeepSeek 客户端发送 JSON Output 请求并读取结果', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'request-1',
      model: 'deepseek-flash',
      choices: [{ finish_reason: 'stop', message: { content: '{"claims":[]}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await createDeepSeekClient({ apiKey: 'test-key', fetchImpl }).extractJson({
    system: '输出 JSON',
    user: '测试',
  });

  assert.equal(result.requestId, 'request-1');
  assert.equal(result.content, '{"claims":[]}');
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.deepEqual(requestBody?.['response_format'], { type: 'json_object' });
});