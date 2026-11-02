import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Supplier, SupplierBankAccount, SupplierChangeRequest, SupplierContact } from '../src/core/objects';

// v0.2 M4 信息变更单（02 §4.2、03 §5，FR-207，BR-11）：采购员代供应商发起 → 采购主管审批 →
// 银行账户变更再经应付会计复核 → 写回档案；驳回不改主记录；退回后修改、重新提交。
// 测试数据全部在这里生成（示例公司名、示例银行），不依赖外部样本。
describe('supplier change request', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (...positions: string[]) => {
    const token = await stack.signUp(`chg-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const request = (id: string) => row(SupplierChangeRequest.name, id);

  // 已合格的供应商（存量导入建档即为合格），带一个有效的默认账户和一位联系人
  const qualifiedSupplier = async () => {
    const n = ++seq;
    const supplier = (await stack.hooks.run(
      Supplier.name,
      'insert',
      {
        name: `示例变更测试有限公司 ${n}`,
        credit_code: `91000000MA0CHG${String(n).padStart(4, '0')}`,
        legal_representative: '张示例',
        address: { street: '示例路 1 号', city: '苏州', country: 'CN' },
        legacy_imported: true,
      },
      { system: true },
    )) as { id: string; name: string; credit_code: string };
    const account = (await stack.hooks.run(
      SupplierBankAccount.name,
      'insert',
      {
        supplier: supplier.id,
        bank_name: '示例银行',
        branch_name: '示例支行',
        account_name: supplier.name,
        account_no: `62220000${String(n).padStart(8, '0')}`,
        status: 'active',
        is_default: true,
      },
      { system: true },
    )) as { id: string };
    const contact = (await stack.hooks.run(
      SupplierContact.name,
      'insert',
      { supplier: supplier.id, name: '李示例', email: `li${n}@example.com`, mobile: '13800000000' },
      { system: true },
    )) as { id: string };
    return { ...supplier, account: account.id, contact: contact.id };
  };

  const submit = async (as: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(SupplierChangeRequest.name, 'insert', { reason: '供应商来函（示例）', ...doc }, { as })) as { id: string };

  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: string, recordId: string, verdict: 'approve' | 'reject' | 'revise', comment: string = verdict) => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
    return req!;
  };

  let buyer: { token: string; id: string };
  let manager: { token: string; id: string };
  let lead: { token: string; id: string };
  let accountant: { token: string; id: string };
  let otherLead: { token: string; id: string };

  beforeAll(async () => {
    stack = await bootStack(config);
    buyer = await person('srm_buyer');
    manager = await person('srm_category_manager');
    lead = await person('srm_buyer_lead');
    accountant = await person('srm_ap_accountant');
    // 审批节点开启时按岗位解析审批人，第二位采购主管要提前任命
    otherLead = await person('srm_buyer_lead');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('snapshots the current record and applies a basic change after one approval', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(buyer.token, {
      supplier: supplier.id,
      change_type: 'basic',
      new_name: `${supplier.name}（更名）`,
      new_legal_representative: '王示例',
    });
    const before = await request(change.id);
    expect(before.status).toBe('in_review');
    expect(before.approval_status).toBe('pending');
    expect(before.before_value).toMatchObject({ name: supplier.name, legal_representative: '张示例' });

    await decide(lead.token, change.id, 'approve');

    const after = await request(change.id);
    expect(after).toMatchObject({ status: 'applied', purchase_approver: lead.id });
    expect(after.applied_at).toBeTruthy();
    expect(after.after_value).toMatchObject({ name: `${supplier.name}（更名）`, legal_representative: '王示例' });
    const updated = await row(Supplier.name, supplier.id);
    expect(updated).toMatchObject({ name: `${supplier.name}（更名）`, legal_representative: '王示例', last_change_request: change.id });
    // 留空的项保持原值
    expect(updated.credit_code).toBe(supplier.credit_code);
  });

  it('leaves the supplier untouched and records the reason when the change is rejected', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(buyer.token, { supplier: supplier.id, change_type: 'basic', new_name: '示例不该生效有限公司' });
    await decide(lead.token, change.id, 'reject', '未见工商变更通知书');
    expect(await request(change.id)).toMatchObject({ status: 'rejected', reject_reason: '未见工商变更通知书' });
    expect((await row(Supplier.name, supplier.id)).name).toBe(supplier.name);
  });

  it('lets the submitter revise a returned change and resubmit it', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(buyer.token, { supplier: supplier.id, change_type: 'basic', new_legal_representative: '赵示例' });
    const first = await decide(lead.token, change.id, 'revise', '法定代表人姓名有误');
    expect((await request(change.id)).approval_status).toBe('returned');

    await stack.hooks.run(SupplierChangeRequest.name, 'update', { id: change.id, new_legal_representative: '钱示例' }, { as: buyer.token });
    const res = await stack.apiAs(buyer.token, 'POST', `/approvals/requests/${first.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await request(change.id)).approval_status).toBe('pending');

    await decide(lead.token, change.id, 'approve');
    expect((await row(Supplier.name, supplier.id)).legal_representative).toBe('钱示例');
    expect((await request(change.id)).status).toBe('applied');
  });

  it('does not let the submitter edit the change while it is under review', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(buyer.token, { supplier: supplier.id, change_type: 'basic', new_name: '示例审批中有限公司' });
    await stack.hooks
      .run(SupplierChangeRequest.name, 'update', { id: change.id, new_name: '示例偷改有限公司' }, { as: buyer.token })
      .catch(() => undefined);
    expect((await request(change.id)).new_name).toBe('示例审批中有限公司');
  });

  it('applies an address change', async () => {
    const supplier = await qualifiedSupplier();
    const address = { street: '示例大道 88 号', city: '成都', country: 'CN' };
    const change = await submit(buyer.token, { supplier: supplier.id, change_type: 'address', new_address: address });
    await decide(lead.token, change.id, 'approve');
    expect((await row(Supplier.name, supplier.id)).address).toMatchObject(address);
    expect((await request(change.id)).after_value).toMatchObject({ address });
  });

  it('applies a contact change', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(buyer.token, {
      supplier: supplier.id,
      change_type: 'contact',
      contact: supplier.contact,
      new_email: 'new-contact@example.com',
    });
    await decide(lead.token, change.id, 'approve');
    expect(await row(SupplierContact.name, supplier.contact)).toMatchObject({ name: '李示例', email: 'new-contact@example.com' });
  });

  it('replaces a bank account only after purchasing and finance both approve', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(manager.token, {
      supplier: supplier.id,
      change_type: 'bank_account',
      bank_account: supplier.account,
      new_bank_name: '示例新银行',
      new_branch_name: '示例新支行',
      new_account_name: supplier.name,
      new_account_no: '6228888800001234',
    });
    // 银行账号不进快照
    expect(JSON.stringify((await request(change.id)).before_value)).not.toContain('6222');

    await decide(lead.token, change.id, 'approve');
    expect(await request(change.id)).toMatchObject({ status: 'in_review', purchase_approver: lead.id });
    expect((await row(SupplierBankAccount.name, supplier.account)).status).toBe('active');

    await decide(accountant.token, change.id, 'approve');
    const done = await request(change.id);
    expect(done).toMatchObject({ status: 'applied', purchase_approver: lead.id, finance_approver: accountant.id });
    expect(await row(SupplierBankAccount.name, supplier.account)).toMatchObject({ status: 'inactive', is_default: false });
    const fresh = await row(SupplierBankAccount.name, String(done.new_bank_account));
    expect(fresh).toMatchObject({
      supplier: supplier.id,
      bank_name: '示例新银行',
      account_no: '6228888800001234',
      status: 'active',
      verified_by: accountant.id,
      is_default: true,
    });
    expect(JSON.stringify(done.after_value)).not.toContain('6228888800001234');
  });

  it('keeps the old bank account when finance rejects', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(manager.token, {
      supplier: supplier.id,
      change_type: 'bank_account',
      bank_account: supplier.account,
      new_bank_name: '示例可疑银行',
      new_account_name: supplier.name,
      new_account_no: '6228888800009999',
    });
    await decide(lead.token, change.id, 'approve');
    await decide(accountant.token, change.id, 'reject', '电话核实供应商未变更账户');
    expect(await request(change.id)).toMatchObject({ status: 'rejected', reject_reason: '电话核实供应商未变更账户' });
    expect(await row(SupplierBankAccount.name, supplier.account)).toMatchObject({ status: 'active', is_default: true });
    expect(await stack.rows(SupplierBankAccount.name, { supplier: supplier.id })).toHaveLength(1);
  });

  // 第 2 级退回：提交人仍是发起人（objectstack#24817 随 18.1.0 修复），改完从第 1 级重新审批
  it('lets finance send a bank change back to the submitter, who resubmits it from the first level', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(manager.token, {
      supplier: supplier.id,
      change_type: 'bank_account',
      bank_account: supplier.account,
      new_bank_name: '示例新银行',
      new_account_name: supplier.name,
      new_account_no: '6228888800005555',
    });
    await decide(lead.token, change.id, 'approve');
    const returned = await decide(accountant.token, change.id, 'revise', '请补支行');
    expect(returned.submitter_id).toBe(manager.id);
    expect(await request(change.id)).toMatchObject({ status: 'in_review', approval_status: 'returned' });

    // 只有发起人能重新提交
    const byLead = await stack.apiAs(lead.token, 'POST', `/approvals/requests/${returned.id}/resubmit`, {});
    expect(byLead.status).not.toBe(200);
    await stack.hooks.run(SupplierChangeRequest.name, 'update', { id: change.id, new_branch_name: '示例新支行' }, { as: manager.token });
    const res = await stack.apiAs(manager.token, 'POST', `/approvals/requests/${returned.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);

    // 从采购主管重新审批，上一轮的财务审批人清空
    const again = await pending(change.id);
    expect(again!.flow_node_id).toBe('purchase_review');
    expect(again!.submitter_id).toBe(manager.id);
    await decide(lead.token, change.id, 'approve');
    expect((await pending(change.id))!.submitter_id).toBe(manager.id);
    await decide(accountant.token, change.id, 'approve');
    expect(await request(change.id)).toMatchObject({ status: 'applied', purchase_approver: lead.id, finance_approver: accountant.id });
    const [created] = (await stack.rows(SupplierBankAccount.name, { supplier: supplier.id })).filter((a) => a.id !== supplier.account);
    expect(created).toMatchObject({ bank_name: '示例新银行', branch_name: '示例新支行', status: 'active' });
  });

  it('does not count an approval by the same person on both levels (BR-11)', async () => {
    const both = await person('srm_buyer_lead', 'srm_ap_accountant');
    const supplier = await qualifiedSupplier();
    const change = await submit(manager.token, {
      supplier: supplier.id,
      change_type: 'bank_account',
      bank_account: supplier.account,
      new_bank_name: '示例新银行',
      new_account_name: supplier.name,
      new_account_no: '6228888800007777',
    });
    await decide(both.token, change.id, 'approve');
    await decide(both.token, change.id, 'approve');
    // 第二次通过不算数，重新开一轮财务复核
    expect(await request(change.id)).toMatchObject({ status: 'in_review', approval_status: 'pending', purchase_approver: both.id });
    expect((await row(SupplierBankAccount.name, supplier.account)).status).toBe('active');
    await decide(accountant.token, change.id, 'approve');
    expect(await request(change.id)).toMatchObject({ status: 'applied', finance_approver: accountant.id });
  });

  it('does not count an approval by the submitter', async () => {
    const supplier = await qualifiedSupplier();
    const change = await submit(lead.token, { supplier: supplier.id, change_type: 'basic', new_legal_representative: '孙示例' });
    await decide(lead.token, change.id, 'approve');
    expect(await request(change.id)).toMatchObject({ status: 'in_review', approval_status: 'pending' });
    expect((await row(Supplier.name, supplier.id)).legal_representative).toBe('张示例');
    await decide(otherLead.token, change.id, 'approve');
    expect(await request(change.id)).toMatchObject({ status: 'applied', purchase_approver: otherLead.id });
  });

  it('refuses a bank change to another supplier\'s or a non-active account', async () => {
    const a = await qualifiedSupplier();
    const b = await qualifiedSupplier();
    const bank = { change_type: 'bank_account', new_bank_name: '示例新银行', new_account_no: '6228888800003333' };
    await expect(submit(manager.token, { supplier: a.id, bank_account: b.account, new_account_name: a.name, ...bank })).rejects.toBeTruthy();
    const pendingAccount = (await stack.hooks.run(
      SupplierBankAccount.name,
      'insert',
      { supplier: a.id, bank_name: '示例银行', account_name: a.name, account_no: '6222000011112222' },
      { system: true },
    )) as { id: string };
    await expect(submit(manager.token, { supplier: a.id, bank_account: pendingAccount.id, new_account_name: a.name, ...bank })).rejects.toBeTruthy();
    await expect(submit(manager.token, { supplier: a.id, bank_account: a.account, new_account_name: '别的示例公司', ...bank })).rejects.toBeTruthy();
    // 采购员读写不了完整账号，不能发起银行账户变更（BR-20）
    await expect(submit(buyer.token, { supplier: a.id, bank_account: a.account, new_account_name: a.name, ...bank })).rejects.toBeTruthy();
  });

  it('refuses an empty basic change', async () => {
    const supplier = await qualifiedSupplier();
    await expect(submit(buyer.token, { supplier: supplier.id, change_type: 'basic' })).rejects.toBeTruthy();
  });

  it('does not let anyone edit the key information of a qualified supplier directly', async () => {
    const supplier = await qualifiedSupplier();
    await expect(
      stack.hooks.run(Supplier.name, 'update', { id: supplier.id, name: '示例直接改名有限公司' }, { as: manager.token }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 资料字段照常可改
    await stack.hooks.run(Supplier.name, 'update', { id: supplier.id, short_name: '示例简称' }, { as: manager.token });
    expect(await row(Supplier.name, supplier.id)).toMatchObject({ name: supplier.name, short_name: '示例简称' });
  });

  it('still lets a supplier under admission be corrected directly', async () => {
    const draft = (await stack.hooks.run(
      Supplier.name,
      'insert',
      { name: '示例准入中有限公司', credit_code: '91000000MA0CHGPOT1' },
      { as: manager.token },
    )) as { id: string };
    await stack.hooks.run(Supplier.name, 'update', { id: draft.id, name: '示例准入中（更正）有限公司' }, { as: manager.token });
    expect((await row(Supplier.name, draft.id)).name).toBe('示例准入中（更正）有限公司');
  });
});
