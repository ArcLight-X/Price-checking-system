/** 小型异步任务池：限制同时进行的请求数，不创建额外依赖。 */
export async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  action: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency 必须是正整数');
  let nextIndex = 0;
  let stopped = false;
  let failure: unknown;

  async function worker(): Promise<void> {
    while (!stopped && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        await action(items[index]!, index);
      } catch (error) {
        // 不再派发新任务；等待其他已发出请求结束后才把错误交给调用方。
        if (!stopped) failure = error;
        stopped = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (stopped) throw failure;
}