import type { VerifyStack } from '@objectstack/verify';

let seq = 0;

/**
 * 模拟一次上传，返回文件 id。文件记录归上传人（`owner_id`），和控制台上传时一样。
 *
 * 18.3.0 起，写入记录时文件字段只能引用调用人自己打开得了的文件（objectstack#25692）：
 * 不归任何人、也没挂到任何记录上的文件会被拒绝。系统身份的写入没有调用人，不受此限，
 * 所以 `token` 只在以某个用户身份写入时需要。一条文件记录只能被一个字段引用，每次各建一条。
 */
export async function uploadedFile(stack: VerifyStack, token?: string, prefix = 'upload'): Promise<string> {
  const owner = token ? { owner_id: String((await stack.contextFor(token)).userId) } : {};
  const name = `${prefix}-${++seq}.pdf`;
  const [file] = await stack.seed('sys_file', [
    { key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed', ...owner },
  ]);
  return String(file!.id);
}
