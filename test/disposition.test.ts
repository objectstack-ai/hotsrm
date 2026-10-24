import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, Supplier, SupplierCategory, SupplierDisposition } from '../src/core/objects';

// v0.3 C3 供应商处置单（02 §4.2、§5.1，03 §5、§12，FR-208，BR-11）：品类经理发起 → 采购总监 →
// 淘汰 / 黑名单 / 解除黑名单再经总经理 → 拉入黑名单最后由内控会签 → 执行。
// 测试数据全部在这里生成（示例公司名、示例品类），不依赖外部样本。
describe('supplier disposition', () => {
  let stack: VerifyStack;
  let seq = 0;

  const person = async (...positions: string[]) => {
    const token = await stack.signUp(`dsp-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const disposition = (id: string) => row(SupplierDisposition.name, id);
  const supplierStatus = async (id: string) => (await row(Supplier.name, id)).status;
  const system = (object: string, doc: Record<string, unknown>) =>
    stack.hooks.run(object, 'insert', doc, { system: true }) as Promise<{ id: string }>;

  const category = async () => {
    const n = ++seq;
    return (await system(Category.name, { code: `DSP${n}`, name: `示例处置品类 ${n}` })).id;
  };

  // 合格供应商（存量导入建档即为合格），三个品类资格：合格、试供、原本就暂停
  const qualifiedSupplier = async () => {
    const n = ++seq;
    const supplier = await system(Supplier.name, {
      name: `示例处置测试有限公司 ${n}`,
      credit_code: `91000000MA0DSP${String(n).padStart(4, '0')}`,
      legacy_imported: true,
    });
    const [qualified, trial, suspended] = [await category(), await category(), await category()];
    const qualification = async (cat: string, status: string) =>
      (await system(SupplierCategory.name, { supplier: supplier.id, category: cat, status })).id;
    return {
      id: supplier.id,
      categories: { qualified, trial, suspended },
      qualifications: {
        qualified: await qualification(qualified, 'qualified'),
        trial: await qualification(trial, 'trial'),
        suspended: await qualification(suspended, 'suspended'),
      },
    };
  };
  const qualificationStatus = async (supplier: Awaited<ReturnType<typeof qualifiedSupplier>>) => ({
    qualified: (await row(SupplierCategory.name, supplier.qualifications.qualified)).status,
    trial: (await row(SupplierCategory.name, supplier.qualifications.trial)).status,
    suspended: (await row(SupplierCategory.name, supplier.qualifications.suspended)).status,
  });

  const submit = async (as: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(SupplierDisposition.name, 'insert', { reason: '示例处置原因', ...doc }, { as })) as { id: string };

  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: string, recordId: string, verdict: 'approve' | 'reject' | 'revise', comment: string = verdict) => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
    return req!;
  };

  let manager: { token: string; id: string };
  let director: { token: string; id: string };
  let gm: { token: string; id: string };
  let compliance: { token: string; id: string };
  let buyer: { token: string; id: string };
  let otherDirector: { token: string; id: string };

  beforeAll(async () => {
    stack = await bootStack(config);
    manager = await person('srm_category_manager');
    director = await person('srm_procurement_director');
    gm = await person('srm_general_manager');
    compliance = await person('srm_procurement_compliance');
    buyer = await person('srm_buyer');
    // 审批节点开启时按岗位解析审批人，第二位采购总监要提前任命
    otherDirector = await person('srm_procurement_director');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('freezes a supplier and restores it and its category qualifications on unfreeze', async () => {
    const supplier = await qualifiedSupplier();
    const freeze = await submit(manager.token, { supplier: supplier.id, action: 'freeze' });
    expect(await disposition(freeze.id)).toMatchObject({ status: 'in_review', approval_status: 'pending', scope: 'all' });
    expect(await supplierStatus(supplier.id)).toBe('qualified');

    await decide(director.token, freeze.id, 'approve');
    const frozen = await disposition(freeze.id);
    expect(frozen).toMatchObject({ status: 'applied', director_approver: director.id });
    expect(frozen.applied_at).toBeTruthy();
    expect(await supplierStatus(supplier.id)).toBe('frozen');
    expect(await qualificationStatus(supplier)).toEqual({ qualified: 'suspended', trial: 'suspended', suspended: 'suspended' });
    expect(await row(SupplierCategory.name, supplier.qualifications.trial)).toMatchObject({
      status_before_freeze: 'trial',
      freeze_scope: 'all',
      freeze_disposition: freeze.id,
    });
    // 原本就暂停的资格没有冻结记录
    expect((await row(SupplierCategory.name, supplier.qualifications.suspended)).freeze_scope ?? null).toBeNull();

    const unfreeze = await submit(manager.token, { supplier: supplier.id, action: 'unfreeze' });
    await decide(director.token, unfreeze.id, 'approve');
    expect((await disposition(unfreeze.id)).status).toBe('applied');
    expect(await supplierStatus(supplier.id)).toBe('qualified');
    expect(await qualificationStatus(supplier)).toEqual({ qualified: 'qualified', trial: 'trial', suspended: 'suspended' });
    expect((await row(SupplierCategory.name, supplier.qualifications.qualified)).freeze_scope ?? null).toBeNull();
  });

  it('freezes and unfreezes only the selected categories', async () => {
    const supplier = await qualifiedSupplier();
    const freeze = await submit(manager.token, {
      supplier: supplier.id,
      action: 'freeze',
      scope: 'category',
      categories: [supplier.categories.qualified],
    });
    await decide(director.token, freeze.id, 'approve');
    expect(await supplierStatus(supplier.id)).toBe('qualified');
    expect(await qualificationStatus(supplier)).toEqual({ qualified: 'suspended', trial: 'trial', suspended: 'suspended' });

    // 全部解冻只对冻结的供应商；指定品类冻结用指定品类解冻
    await expect(submit(manager.token, { supplier: supplier.id, action: 'unfreeze' })).rejects.toBeTruthy();
    const unfreeze = await submit(manager.token, {
      supplier: supplier.id,
      action: 'unfreeze',
      scope: 'category',
      categories: [supplier.categories.qualified, supplier.categories.suspended],
    });
    await decide(director.token, unfreeze.id, 'approve');
    // 原本就暂停的品类即使被选中也不恢复
    expect(await qualificationStatus(supplier)).toEqual({ qualified: 'qualified', trial: 'trial', suspended: 'suspended' });
  });

  it('eliminates a supplier after the director and the general manager approve', async () => {
    const supplier = await qualifiedSupplier();
    const eliminate = await submit(manager.token, { supplier: supplier.id, action: 'eliminate' });
    await decide(director.token, eliminate.id, 'approve');
    expect(await disposition(eliminate.id)).toMatchObject({ status: 'in_review', director_approver: director.id });
    expect(await supplierStatus(supplier.id)).toBe('qualified');

    await decide(gm.token, eliminate.id, 'approve');
    expect(await disposition(eliminate.id)).toMatchObject({ status: 'applied', gm_approver: gm.id });
    expect(await supplierStatus(supplier.id)).toBe('eliminated');
    expect(await qualificationStatus(supplier)).toEqual({ qualified: 'suspended', trial: 'suspended', suspended: 'suspended' });
  });

  it('blacklists a frozen supplier with a compliance countersign, and removing it leaves the supplier eliminated', async () => {
    const supplier = await qualifiedSupplier();
    const freeze = await submit(manager.token, { supplier: supplier.id, action: 'freeze' });
    await decide(director.token, freeze.id, 'approve');

    const blacklist = await submit(manager.token, { supplier: supplier.id, action: 'blacklist' });
    await decide(director.token, blacklist.id, 'approve');
    await decide(gm.token, blacklist.id, 'approve');
    expect((await disposition(blacklist.id)).status).toBe('in_review');
    expect(await supplierStatus(supplier.id)).toBe('frozen');
    await decide(compliance.token, blacklist.id, 'approve');
    expect(await disposition(blacklist.id)).toMatchObject({
      status: 'applied',
      director_approver: director.id,
      gm_approver: gm.id,
      compliance_approver: compliance.id,
    });
    expect(await supplierStatus(supplier.id)).toBe('blacklisted');
    // 淘汰 / 黑名单清掉冻结记录，免得日后解冻把没重新准入的品类恢复
    expect((await row(SupplierCategory.name, supplier.qualifications.qualified)).freeze_scope ?? null).toBeNull();

    const remove = await submit(manager.token, { supplier: supplier.id, action: 'remove_blacklist' });
    await decide(director.token, remove.id, 'approve');
    await decide(gm.token, remove.id, 'approve');
    expect(await disposition(remove.id)).toMatchObject({ status: 'applied', gm_approver: gm.id });
    expect(await supplierStatus(supplier.id)).toBe('eliminated');
  });

  it('leaves the supplier untouched and records the reason when the disposition is rejected', async () => {
    const supplier = await qualifiedSupplier();
    const eliminate = await submit(manager.token, { supplier: supplier.id, action: 'eliminate' });
    await decide(director.token, eliminate.id, 'approve');
    await decide(gm.token, eliminate.id, 'reject', '整改期未满，先冻结观察');
    expect(await disposition(eliminate.id)).toMatchObject({ status: 'rejected', reject_reason: '整改期未满，先冻结观察' });
    expect(await supplierStatus(supplier.id)).toBe('qualified');
    expect(await qualificationStatus(supplier)).toEqual({ qualified: 'qualified', trial: 'trial', suspended: 'suspended' });
  });

  it('lets the submitter revise a returned disposition and resubmit it', async () => {
    const supplier = await qualifiedSupplier();
    const freeze = await submit(manager.token, { supplier: supplier.id, action: 'freeze', reason: '质量问题' });
    const first = await decide(director.token, freeze.id, 'revise', '请写明不合格批次');
    expect((await disposition(freeze.id)).approval_status).toBe('returned');

    await stack.hooks.run(SupplierDisposition.name, 'update', { id: freeze.id, reason: '示例批次连续两批不合格' }, { as: manager.token });
    const res = await stack.apiAs(manager.token, 'POST', `/approvals/requests/${first.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    await decide(director.token, freeze.id, 'approve');
    expect(await disposition(freeze.id)).toMatchObject({ status: 'applied', reason: '示例批次连续两批不合格' });
    expect(await supplierStatus(supplier.id)).toBe('frozen');
  });

  it('does not count an approval by the submitter (BR-11)', async () => {
    const both = await person('srm_category_manager', 'srm_procurement_director');
    const supplier = await qualifiedSupplier();
    const freeze = await submit(both.token, { supplier: supplier.id, action: 'freeze' });
    await decide(both.token, freeze.id, 'approve');
    expect(await disposition(freeze.id)).toMatchObject({ status: 'in_review', approval_status: 'pending' });
    expect(await supplierStatus(supplier.id)).toBe('qualified');
    await decide(otherDirector.token, freeze.id, 'approve');
    expect(await disposition(freeze.id)).toMatchObject({ status: 'applied', director_approver: otherDirector.id });
  });

  it('does not count an approval by the same person on two levels (BR-11)', async () => {
    const both = await person('srm_procurement_director', 'srm_general_manager');
    const supplier = await qualifiedSupplier();
    const eliminate = await submit(manager.token, { supplier: supplier.id, action: 'eliminate' });
    await decide(both.token, eliminate.id, 'approve');
    await decide(both.token, eliminate.id, 'approve');
    expect(await disposition(eliminate.id)).toMatchObject({ status: 'in_review', approval_status: 'pending', director_approver: both.id });
    expect(await supplierStatus(supplier.id)).toBe('qualified');
    await decide(gm.token, eliminate.id, 'approve');
    expect(await disposition(eliminate.id)).toMatchObject({ status: 'applied', gm_approver: gm.id });
  });

  it('refuses actions the supplier status does not allow', async () => {
    const supplier = await qualifiedSupplier();
    const potential = await system(Supplier.name, { name: '示例潜在有限公司', credit_code: '91000000MA0DSPPOT1' });
    await expect(submit(manager.token, { supplier: potential.id, action: 'freeze' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(submit(manager.token, { supplier: supplier.id, action: 'unfreeze' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(submit(manager.token, { supplier: supplier.id, action: 'remove_blacklist' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // 淘汰不能指定品类；指定品类要选品类
    await expect(
      submit(manager.token, { supplier: supplier.id, action: 'eliminate', scope: 'category', categories: [supplier.categories.qualified] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(submit(manager.token, { supplier: supplier.id, action: 'freeze', scope: 'category' })).rejects.toBeTruthy();
    // 原因必填
    await expect(submit(manager.token, { supplier: supplier.id, action: 'freeze', reason: '' })).rejects.toBeTruthy();
  });

  it('allows only one disposition in review per supplier', async () => {
    const supplier = await qualifiedSupplier();
    await submit(manager.token, { supplier: supplier.id, action: 'freeze' });
    await expect(submit(manager.token, { supplier: supplier.id, action: 'eliminate' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('does not let a buyer raise a disposition or anyone set the supplier status directly', async () => {
    const supplier = await qualifiedSupplier();
    await expect(submit(buyer.token, { supplier: supplier.id, action: 'freeze' })).rejects.toBeTruthy();
    await stack.hooks
      .run(Supplier.name, 'update', { id: supplier.id, status: 'frozen' }, { as: manager.token })
      .catch(() => undefined);
    expect(await supplierStatus(supplier.id)).toBe('qualified');
    await stack.hooks
      .run(SupplierCategory.name, 'update', { id: supplier.qualifications.qualified, status_before_freeze: 'trial' }, { as: manager.token })
      .catch(() => undefined);
    expect((await row(SupplierCategory.name, supplier.qualifications.qualified)).status_before_freeze ?? null).toBeNull();
  });
});
