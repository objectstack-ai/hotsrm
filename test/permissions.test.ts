import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierApplication, SupplierBankAccount } from '../src/core/objects';
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
        "srm_contract": "R",
        "srm_contract_line": "R",
        "srm_delivery_record": "R",
        "srm_kpi": "R",
        "srm_material": "R",
        "srm_plant": "R",
        "srm_quality_issue": "RE",
        "srm_risk_event": "R",
        "srm_supplier": "R",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_change_request": "R",
        "srm_supplier_contact": "R",
        "srm_supplier_disposition": "R",
      }
    `);
  });

  it('keeps what a buyer lead can see', () => {
    expect(visibility('srm_buyer_lead')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_contract": "RCE",
        "srm_contract_line": "RCE",
        "srm_delivery_record": "R",
        "srm_kpi": "R",
        "srm_material": "RE",
        "srm_plant": "R",
        "srm_quality_issue": "R",
        "srm_risk_event": "RCE",
        "srm_supplier": "RCE",
        "srm_supplier_application": "RCE",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "RCE",
        "srm_supplier_category": "RCE",
        "srm_supplier_certificate": "RCE",
        "srm_supplier_change_request": "RCE",
        "srm_supplier_contact": "RCED",
        "srm_supplier_disposition": "RCE",
      }
    `);
  });

  // v0.3 C4：法务、总经理、内控（04 §2.1–2.2）。srm_legal 的合同权限随合同对象（v0.3 C1）补齐
  it('keeps what a legal counsel can see', () => {
    expect(visibility('srm_legal_counsel')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_contract": "RE",
        "srm_contract_line": "RE",
        "srm_delivery_record": "R",
        "srm_kpi": "R",
        "srm_material": "R",
        "srm_plant": "R",
        "srm_quality_issue": "R",
        "srm_risk_event": "R",
        "srm_supplier": "R",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_contact": "R",
        "srm_supplier_disposition": "R",
      }
    `);
  });

  it('keeps what a general manager can see', () => {
    expect(visibility('srm_general_manager')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_contract": "R",
        "srm_contract_line": "R",
        "srm_delivery_record": "R",
        "srm_kpi": "R",
        "srm_material": "R",
        "srm_plant": "R",
        "srm_quality_issue": "R",
        "srm_risk_event": "R",
        "srm_supplier": "R",
        "srm_supplier_application": "R",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_change_request": "R",
        "srm_supplier_contact": "R",
        "srm_supplier_disposition": "R",
      }
    `);
  });

  it('keeps what procurement compliance can see', () => {
    expect(visibility('srm_procurement_compliance')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_contract": "R",
        "srm_contract_line": "R",
        "srm_delivery_record": "R",
        "srm_kpi": "R",
        "srm_material": "R",
        "srm_plant": "R",
        "srm_quality_issue": "R",
        "srm_risk_event": "R",
        "srm_supplier": "R",
        "srm_supplier_application": "R",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_change_request": "R",
        "srm_supplier_contact": "R",
        "srm_supplier_disposition": "R",
      }
    `);
  });

  // v0.4 Q0：质量经理权限同 SQE（会签由 flow 授予）；IQC 检验员录入交付记录（v0.4 Q1）
  it('keeps what a procurement director can see', () => {
    expect(visibility('srm_procurement_director')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_contract": "RE",
        "srm_contract_line": "R",
        "srm_delivery_record": "R",
        "srm_kpi": "RCE",
        "srm_material": "RE",
        "srm_plant": "R",
        "srm_quality_issue": "R",
        "srm_risk_event": "R",
        "srm_supplier": "R",
        "srm_supplier_application": "R",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_change_request": "RCE",
        "srm_supplier_contact": "R",
        "srm_supplier_disposition": "R",
      }
    `);
  });

  it('gives the quality manager the same access as an SQE', () => {
    expect(visibility('srm_quality_manager')).toEqual(visibility('srm_sqe'));
  });

  it('keeps what an IQC inspector can see', () => {
    expect(visibility('srm_iqc_inspector')).toMatchInlineSnapshot(`
      {
        "srm_category": "R",
        "srm_delivery_record": "RCE",
        "srm_kpi": "R",
        "srm_material": "R",
        "srm_plant": "R",
        "srm_quality_issue": "R",
        "srm_risk_event": "R",
        "srm_supplier": "R",
        "srm_supplier_audit": "R",
        "srm_supplier_audit_finding": "R",
        "srm_supplier_bank_account": "R",
        "srm_supplier_category": "R",
        "srm_supplier_certificate": "R",
        "srm_supplier_contact": "R",
        "srm_supplier_disposition": "R",
      }
    `);
  });

  it('lets legal, the general manager and compliance read suppliers but not edit or create one', async () => {
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { system: true });
    for (const position of ['srm_legal_counsel', 'srm_general_manager', 'srm_procurement_compliance']) {
      const reader = await person(position);
      const [row] = await stack.rows(Supplier.name, { id: supplier.id }, { as: reader });
      expect(row!.name).toBe(supplier.name);
      await expect(stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: '越权改名' }, { as: reader })).rejects.toBeTruthy();
      await expect(stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: reader })).rejects.toBeTruthy();
    }
  });

  it('lets compliance read admission applications and see only the last 4 digits of a bank account', async () => {
    const manager = await person('srm_category_manager');
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { as: manager });
    const [category] = await stack.rows('srm_category', { code: 'ELEC' }, { as: manager });
    const app = await stack.hooks.run(SupplierApplication.name, 'insert', { supplier: supplier.id, applied_categories: [category!.id] }, { as: manager });
    const account = await stack.hooks.run(
      SupplierBankAccount.name,
      'insert',
      { supplier: supplier.id, bank_name: '示例银行', branch_name: '示例支行', account_name: supplier.name, account_no: `62220000${String(++seq).padStart(8, '0')}` },
      { as: manager },
    );
    const compliance = await person('srm_procurement_compliance');
    expect(await stack.rows(SupplierApplication.name, { id: app.id }, { as: compliance })).toHaveLength(1);
    const [masked] = await stack.rows(SupplierBankAccount.name, { id: account.id }, { as: compliance });
    expect(masked!.account_no).not.toBe(account.account_no);
    expect(String(masked!.account_no).endsWith(String(account.account_no).slice(-4))).toBe(true);
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

  // 供应商 OWD 暂为 public_read_write（objectstack#25470）：维护者能改别人建的供应商，但删不了
  it('lets supplier maintainers edit a supplier they do not own but not delete it', async () => {
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { system: true });
    for (const position of ['srm_category_manager', 'srm_buyer_lead']) {
      const maintainer = await person(position);
      await stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: `改名 ${position}` }, { as: maintainer });
      await expect(stack.hooks.run(Supplier.name, 'delete', { id: supplier.id }, { as: maintainer })).rejects.toBeTruthy();
    }
    expect(await stack.rows(Supplier.name, { id: supplier.id })).toHaveLength(1);
  });

  it('keeps supplier fields read-only for an SQE', async () => {
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { system: true });
    const sqe = await person('srm_sqe');
    await expect(stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: 'SQE 改名' }, { as: sqe })).rejects.toBeTruthy();
    await expect(stack.hooks.run(Supplier.name, 'delete', { id: supplier.id }, { as: sqe })).rejects.toBeTruthy();
  });

  it('does not let a buyer or an AP accountant edit a supplier', async () => {
    const supplier = await stack.hooks.run(Supplier.name, 'insert', supplierDoc(), { system: true });
    for (const position of ['srm_buyer', 'srm_ap_accountant']) {
      const reader = await person(position);
      await expect(stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: '越权改名' }, { as: reader })).rejects.toBeTruthy();
    }
  });

  it('keeps admission applications out of a buyer\'s reach', async () => {
    const buyer = await person('srm_buyer');
    await expect(stack.rows(SupplierApplication.name, {}, { as: buyer })).rejects.toBeTruthy();
  });
});
