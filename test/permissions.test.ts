import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierApplication } from '../src/core/objects';
import { SrmPermissionSets } from '../src/core/security/permission-sets';
import { SrmPositions } from '../src/core/security/positions';

type Access = { allowCreate: boolean; allowRead: boolean; allowEdit: boolean; allowDelete: boolean };

// 岗位「能看到什么」：把岗位挂载的权限集按对象合并成 R/C/E/D 字符串，权限变更时对比快照（工程规范 §4）
const visibility = (position: string) => {
  const sets = SrmPositions.find((p) => p.name === position)!.permissionSets.map(
    (name) => SrmPermissionSets.find((set) => set.name === name)!,
  );
  const merged: Record<string, string> = {};
  for (const set of sets) {
    for (const [object, access] of Object.entries(set.objects as Record<string, Access>)) {
      const flags = (merged[object] ?? '').split('');
      if (access.allowRead) flags.push('R');
      if (access.allowCreate) flags.push('C');
      if (access.allowEdit) flags.push('E');
      if (access.allowDelete) flags.push('D');
      merged[object] = 'RCED'.split('').filter((f) => flags.includes(f)).join('');
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
};

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

  it('mounts only permission sets that exist', () => {
    const names = new Set(SrmPermissionSets.map((set) => set.name));
    for (const position of SrmPositions) {
      expect(position.permissionSets.filter((name) => !names.has(name))).toEqual([]);
    }
  });

  it('keeps what an AP accountant can see', () => {
    expect(visibility('srm_ap_accountant')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_material": "R",
        "srm_plant": "R",
        "srm_supplier": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_contact": "R",
      }
    `);
  });

  it('keeps what a buyer lead can see', () => {
    expect(visibility('srm_buyer_lead')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_material": "RE",
        "srm_plant": "R",
        "srm_supplier": "RCE",
        "srm_supplier_application": "RCE",
        "srm_supplier_bank_account": "RCE",
        "srm_supplier_category": "RCE",
        "srm_supplier_certificate": "RCE",
        "srm_supplier_contact": "RCED",
      }
    `);
  });

  it('lets an AP accountant read suppliers but not edit or create one', async () => {
    const manager = await person('srm_category_manager');
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: manager });
    const accountant = await person('srm_ap_accountant');
    const [row] = await stack.rows(Supplier.name, { id: supplier.id }, { as: accountant });
    expect(row!.name).toBe(supplier.name);
    await expect(
      stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: '改名' }, { as: accountant }),
    ).rejects.toBeTruthy();
    await expect(stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: accountant })).rejects.toBeTruthy();
    await expect(stack.rows(SupplierApplication.name, {}, { as: accountant })).rejects.toBeTruthy();
  });

  it('lets a buyer lead maintain suppliers but not set the status directly', async () => {
    const lead = await person('srm_buyer_lead');
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: lead });
    await stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: '简称' }, { as: lead });
    await expect(
      stack.hooks.run(Supplier.name, 'update', { id: supplier.id, status: 'eliminated' }, { as: lead }),
    ).rejects.toBeTruthy();
    const [row] = await stack.rows(Supplier.name, { id: supplier.id }, { as: lead });
    expect(row).toMatchObject({ short_name: '简称', status: 'potential' });
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
