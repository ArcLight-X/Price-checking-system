import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRootComments } from '../src/comment-selection.ts';
import type { CommentRow } from '../src/types.ts';

function comment(rpid: string, likeCount: number, ctime: number, content = rpid): CommentRow {
  return {
    rpid,
    bvid: 'BV-test',
    oid: '1',
    parent: '0',
    root: '0',
    isRoot: true,
    uname: '用户',
    content,
    likeCount,
    ctime,
    location: '',
    subCount: 0,
    subFetchedCount: 0,
    subContextComplete: true,
    raw: '{}',
  };
}

test('热门组按点赞数取前 N 条', () => {
  const selection = selectRootComments([
    comment('low', 1, 300),
    comment('high', 100, 100),
    comment('middle', 50, 200),
  ], [], 2, 0);

  assert.deepEqual(selection.hotRows.map((row) => row.rpid), ['high', 'middle']);
  assert.deepEqual(selection.rows.map((row) => row.rpid), ['high', 'middle']);
});

test('最新组按发布时间取前 N 条', () => {
  const selection = selectRootComments([], [
    comment('old', 100, 100),
    comment('newest', 1, 300),
    comment('newer', 2, 200),
  ], 0, 2);

  assert.deepEqual(selection.recentRows.map((row) => row.rpid), ['newest', 'newer']);
  assert.deepEqual(selection.rows.map((row) => row.rpid), ['newest', 'newer']);
});

test('热门与最新重叠时按 rpid 去重且使用后抓到的新数据', () => {
  const selection = selectRootComments(
    [comment('same', 10, 100, '热门流旧内容'), comment('hot-only', 9, 90)],
    [comment('same', 12, 110, '最新流新内容'), comment('recent-only', 0, 200)],
    2,
    2,
  );

  assert.equal(selection.overlapCount, 1);
  assert.deepEqual(selection.rows.map((row) => row.rpid), ['same', 'hot-only', 'recent-only']);
  assert.equal(selection.rows[0]?.content, '最新流新内容');
  assert.equal(selection.rows[0]?.likeCount, 12);
});

test('默认配额是热门 50 条和最新 30 条', () => {
  const hot = Array.from({ length: 60 }, (_, index) => comment(`hot-${index}`, 1000 - index, index));
  const recent = Array.from({ length: 40 }, (_, index) => comment(`recent-${index}`, index, 1000 + index));
  const selection = selectRootComments(hot, recent);

  assert.equal(selection.hotRows.length, 50);
  assert.equal(selection.recentRows.length, 30);
  assert.equal(selection.rows.length, 80);
});

test('支持零配额、候选不足和候选流内部重复', () => {
  const duplicateOld = comment('duplicate', 1, 100, '旧对象');
  const duplicateNew = comment('duplicate', 99, 200, '新对象');

  const zeroSelection = selectRootComments([duplicateOld], [duplicateNew], 0, 0);
  assert.deepEqual(zeroSelection.rows, []);

  const shortSelection = selectRootComments(
    [duplicateOld, duplicateNew, comment('only-one-more', 2, 50)],
    [],
    50,
    30,
  );
  assert.deepEqual(shortSelection.hotRows.map((row) => row.rpid), ['duplicate', 'only-one-more']);
  assert.equal(shortSelection.hotRows[0]?.content, '新对象');
  assert.equal(shortSelection.rows.length, 2);
});