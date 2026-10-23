import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierApplication } from '../src/core/objects';
import { SrmPermissionSets } from '../src/core/security/permission-sets';

// 内部岗位与权限集（04 §2）：采购员只读，品类经理维护档案但不能直接改状态。
describe('internal permissions', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (position: string) => {
    const token = await stack.signUp(`${position}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', [{ user_id: String(context.userId), position, ...org }]);
    return token;
  };
  const supplierDoc = () => ({ name: `权限测试供应商 ${++seq}`, credit_code: `91000000MA0PRM${String(seq).padStart(4, '0')}` });

  beforeAll(async () => {
    stack = await bootStack(config);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('sets no internal permission set as the default', () => {
    expect(SrmPermissionSets.filter((set) => 'isDefault' in set)).toEqual([]);
  });

  it('lets a buyer read suppliers but not create one', async () => {
    const buyer = await person('srm_buyer');
    expect((await stack.rows(Supplier.name, {}, { as: buyer })).length).toBeGreaterThan(0);
    await expect(stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: buyer })).rejects.toBeTruthy();
  });

  it('lets a category manager register a supplier and apply for admission', async () => {
    const manager = await person('srm_category_manager');
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: manager });
    const [category] = await stack.rows('srm_category', { code: 'ELEC' }, { as: manager });
    const app = await stack.hooks.run(
      SupplierApplication.name,
      'insert',
      { supplier: supplier.id, applied_categories: [category!.id] },
      { as: manager },
    );
    expect(app.id).toBeTruthy();
  });

  it('does not let a category manager set the supplier status directly', async () => {
    const manager = await person('srm_category_manager');
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: manager });
    await expect(
      stack.hooks.run(Supplier.name, 'update', { id: supplier.id, status: 'eliminated' }, { as: manager }),
    ).rejects.toBeTruthy();
    const [row] = await stack.rows(Supplier.name, { id: supplier.id }, { as: manager });
    expect(row!.status).toBe('potential');
  });

  it('keeps admission applications out of a buyer\'s reach', async () => {
    const buyer = await person('srm_buyer');
    await expect(stack.rows(SupplierApplication.name, {}, { as: buyer })).rejects.toBeTruthy();
  });
});
