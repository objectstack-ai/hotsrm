import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category } from '../src/core/objects';

// 在进程内用内存库启动整个应用，走与 REST API 相同的校验和权限路径。
describe('core boots', () => {
  let stack: VerifyStack;
  let admin: string;

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await stack.signIn();
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('identifies as the hotsrm app', () => {
    expect(config.manifest).toMatchObject({ id: 'app.objectstack.hotsrm', namespace: 'srm', type: 'app' });
  });

  it('refuses a category without a code', async () => {
    await expect(
      stack.hooks.run(Category.name, 'insert', { name: '电子元器件' }, { as: admin }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'code', code: 'required' }],
    });
  });

  it('saves a category with its defaults', async () => {
    const row = await stack.hooks.run(
      Category.name,
      'insert',
      { code: 'BOOT', name: '启动测试品类' },
      { as: admin },
    );
    expect(row).toMatchObject({ code: 'BOOT', risk_class: 'medium', is_direct: true });
  });
});
