import type { VerifyStack } from '@objectstack/verify';

type Row = Record<string, any>;

/**
 * 以 `token` 的身份经 trigger 入口（`POST /automation/:name/trigger`）直接启动 flow，并指明记录所在对象。
 *
 * 18.3.0 起，按名字启动 flow 的入口先以调用人身份读这次启动指向的记录（objectstack#29050）：
 * 读不到答 404、不产生运行；系统身份的 flow 只给 `recordId` 不给 `objectName` 答 400。
 * `stack.flows.run` 把参数整包放进 `params`，传不了顶层的 `objectName`，所以这里直接调接口。
 *
 * 返回运行结果（与 `stack.flows.run` 相同，含 `flowName`）；入口拒绝时抛出，消息里带状态码和 `code`。
 */
export async function triggerFlow(stack: VerifyStack, token: string, flow: string, objectName: string, recordId: string, params: Row = {}): Promise<Row> {
  const res = await stack.apiAs(token, 'POST', `/automation/${encodeURIComponent(flow)}/trigger`, { objectName, recordId, params });
  const body = (await res.json().catch(() => null)) as Row | null;
  if (res.status >= 400) {
    const error = body?.error ?? body;
    throw new Error(`trigger ${flow} answered ${res.status} ${error?.code ?? ''}: ${error?.message ?? JSON.stringify(body)}`);
  }
  return { ...(body?.data ?? {}), flowName: flow };
}

/** 入口以「记录不存在」拒绝（调用人读不到这条记录）时的错误 */
export const NOT_FOUND = /answered 404/;
