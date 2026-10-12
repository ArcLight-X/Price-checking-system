import assert from 'node:assert/strict';
import test from 'node:test';
import { createArkClient, parseModelJson } from '../src/ark.ts';

test('解析纯 JSON 和 Markdown JSON 代码块', () => {
  assert.deepEqual(parseModelJson('{"claims":[]}'), { claims: [] });
  assert.deepEqual(parseModelJson('```json\n{"claims":[]}\n```'), { claims: [] });
});

test('火山方舟客户端发送 Responses 请求并读取结果', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'request-1',
      model: 'doubao-seed-2-0-mini-260428',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"claims":[]}' }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await createArkClient({ apiKey: 'test-key', fetchImpl }).extractJson({
    system: '输出 JSON',
    user: '测试',
  });

  assert.equal(result.requestId, 'request-1');
  assert.equal(result.content, '{"claims":[]}');
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(requestBody?.['model'], 'doubao-seed-2-0-mini-260428');
  assert.equal(requestBody?.['max_output_tokens'], 4096);
  assert.equal(Array.isArray(requestBody?.['input']), true);
});

test('火山方舟首次返回空内容时自动重试一次', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: calls === 1 ? '' : '{"claims":[]}' }] }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await createArkClient({ apiKey: 'test-key', fetchImpl }).extractJson({
    system: '输出 JSON',
    user: '测试',
  });
  assert.equal(calls, 2);
  assert.equal(result.content, '{"claims":[]}');
});