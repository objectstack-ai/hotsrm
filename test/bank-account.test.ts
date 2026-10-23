import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierBankAccount } from '../src/core/objects';
import { SrmPermissionSets } from '../src/core/security/permission-sets';

// v0.2 M2 银行账户（02 §4.1、03 §13、04 §4.2，BR-20）：采购侧新建为「待核验」并锁定，
// 应付会计经 srm_bank_verify 核验后有效；新建人不能核验；完整账号只有应付会计与供应商管理可读。
describe('supplier bank account', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (...positions: string[]) => {
    const token = await stack.signUp(`bank-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return token;
  };
  const read = async (id: string) => (await stack.rows(SupplierBankAccount.name, { id }))[0]!;

  const newSupplier = async (as: string, country = 'cn') => {
    const n = ++seq;
    const doc =
      country === 'cn'
        ? { name: `银行测试供应商 ${n}`, credit_code: `91000000MA0BNK${String(n).padStart(4, '0')}` }
        : { name: `Bank Test Supplier ${n} GmbH`, country, registration_no: `HRB${n}` };
    return (await stack.hooks.run(Supplier.name, 'insert', doc, { as })) as { id: string; name: string };
  };
  const newAccount = async (as: string, supplier: { id: string; name: string }, extra: Record<string, unknown> = {}) =>
    (await stack.hooks.run(
      SupplierBankAccount.name,
      'insert',
      {
        supplier: supplier.id,
        bank_name: '示例银行',
        branch_name: '示例支行',
        account_name: supplier.name,
        account_no: `62220000${String(++seq).padStart(8, '0')}`,
        ...extra,
      },
      { as },
    )) as { id: string; account_no: string };

  // 从详情页按钮启动核验，停在确认屏后提交
  const verify = async (as: string, recordId: string) => {
    const started = (await stack.actions.run(SupplierBankAccount.name, 'srm_bank_verify', { as, recordId })) as {
      status?: string;
      runId?: string;
    };
    if (started.status !== 'paused') return started;
    return stack.flows.resume({ flowName: 'srm_bank_verify', runId: started.runId }, {}, { as });
  };

  let manager: string;
  let accountant: string;

  beforeAll(async () => {
    stack = await bootStack(config);
    manager = await person('srm_category_manager');
    accountant = await person('srm_ap_accountant');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('creates an account pending verification even if the creator asks for active', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier, { status: 'active', verified_by: null });
    expect(await read(account.id)).toMatchObject({ status: 'pending_verify', bank_name: '示例银行', account_no: account.account_no });
  });

  it('does not let a new account be the default before it is verified', async () => {
    const supplier = await newSupplier(manager);
    await expect(newAccount(manager, supplier, { is_default: true })).rejects.toBeTruthy();
  });

  it('runs create → verify → active and records the verifier', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier);
    const run = await verify(accountant, account.id);
    expect(run, JSON.stringify(run)).toMatchObject({ success: true });
    const row = await read(account.id);
    expect(row.status).toBe('active');
    expect(row.verified_by).toBe(String((await stack.contextFor(accountant)).userId));
  });

  it('refuses verification by the person who created the account', async () => {
    const both = await person('srm_category_manager', 'srm_ap_accountant');
    const supplier = await newSupplier(both);
    const account = await newAccount(both, supplier);
    const run = (await verify(both, account.id)) as { status?: string };
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(run)).toContain('a bank account you created');
    expect((await read(account.id)).status).toBe('pending_verify');
  });

  it('refuses verification by someone who is not an AP accountant', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier);
    const other = await person('srm_category_manager');
    const run = (await verify(other, account.id)) as { status?: string };
    expect(run, JSON.stringify(run)).toMatchObject({ status: 'refused' });
    expect(JSON.stringify(run)).toContain('Only AP accountants');
    expect((await read(account.id)).status).toBe('pending_verify');
  });

  it('keeps a pending account locked', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier);
    await stack.hooks
      .run(SupplierBankAccount.name, 'update', { id: account.id, bank_name: '改过的银行', account_no: '6222999999999999' }, { as: manager })
      .catch(() => undefined);
    expect(await read(account.id)).toMatchObject({ bank_name: '示例银行', account_no: account.account_no });
  });

  it('keeps the key fields of an active account read-only but lets it become the default', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier);
    await verify(accountant, account.id);
    await stack.hooks
      .run(SupplierBankAccount.name, 'update', { id: account.id, account_no: '6222999999999999' }, { as: manager })
      .catch(() => undefined);
    await stack.hooks.run(SupplierBankAccount.name, 'update', { id: account.id, is_default: true }, { as: manager });
    expect(await read(account.id)).toMatchObject({ account_no: account.account_no, is_default: true });
  });

  it('allows at most one default account per supplier', async () => {
    const supplier = await newSupplier(manager);
    const first = await newAccount(manager, supplier);
    const second = await newAccount(manager, supplier);
    await verify(accountant, first.id);
    await verify(accountant, second.id);
    await stack.hooks.run(SupplierBankAccount.name, 'update', { id: first.id, is_default: true }, { as: manager });
    await expect(
      stack.hooks.run(SupplierBankAccount.name, 'update', { id: second.id, is_default: true }, { as: manager }),
    ).rejects.toBeTruthy();
    expect((await read(second.id)).is_default).toBe(false);
  });

  it('requires a domestic account name to match the supplier name', async () => {
    const supplier = await newSupplier(manager);
    await expect(newAccount(manager, supplier, { account_name: '别的公司' })).rejects.toBeTruthy();
  });

  it('does not check the account name of an overseas supplier', async () => {
    const supplier = await newSupplier(manager, 'de');
    const account = await newAccount(manager, supplier, { account_name: 'Bank Test Supplier', currency: 'eur', swift_code: 'DEUTDEFF' });
    expect((await read(account.id)).status).toBe('pending_verify');
  });

  it('shows the full account number to AP accountants and supplier admins only', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier);
    const buyer = await person('srm_buyer');
    const [asAccountant] = await stack.rows(SupplierBankAccount.name, { id: account.id }, { as: accountant });
    const [asManager] = await stack.rows(SupplierBankAccount.name, { id: account.id }, { as: manager });
    const [asBuyer] = await stack.rows(SupplierBankAccount.name, { id: account.id }, { as: buyer });
    expect(asAccountant!.account_no).toBe(account.account_no);
    expect(asManager!.account_no).toBe(account.account_no);
    expect(asBuyer!.account_no).not.toBe(account.account_no);
    expect(String(asBuyer!.account_no).endsWith(account.account_no.slice(-4))).toBe(true);
  });

  it('grants no permission set export on bank accounts', () => {
    const exporting = SrmPermissionSets.filter(
      (set) => (set.objects as Record<string, { allowExport?: boolean }>).srm_supplier_bank_account?.allowExport,
    );
    expect(exporting).toEqual([]);
  });

  it('does not let an AP accountant edit an account directly', async () => {
    const supplier = await newSupplier(manager);
    const account = await newAccount(manager, supplier);
    await expect(
      stack.hooks.run(SupplierBankAccount.name, 'update', { id: account.id, branch_name: '改' }, { as: accountant }),
    ).rejects.toBeTruthy();
  });
});
