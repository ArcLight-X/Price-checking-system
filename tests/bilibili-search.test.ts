import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchVideoSearch } from '../src/bilibili/api.ts';
import type { BiliClient } from '../src/bilibili/client.ts';

test('B站搜索结果清理标题、按 bvid 去重并限制数量', async () => {
  const client: BiliClient = {
    cookieSummary: () => '无',
    request: async <T>() => ({
      result: [
        { bvid: 'BV1111111111', title: '<em class="keyword">显卡</em> 价格', author: '甲', play: 10, review: 2 },
        { bvid: 'BV1111111111', title: '重复', author: '甲' },
        { bvid: 'BV2222222222', title: '购买建议', author: '乙', play: 20, review: 3 },
      ],
    }) as unknown as T,
  };

  const rows = await fetchVideoSearch(client, '显卡', 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.title, '显卡 价格');
  assert.deepEqual(rows.map((row) => row.bvid), ['BV1111111111', 'BV2222222222']);
});