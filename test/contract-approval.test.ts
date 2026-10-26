import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Contract, ContractLine, Supplier } from '../src/core/objects';

// v0.3 C2 合同审批（03 §6 第 2 步、§12 合同行，BR-11）：提交审批 → 法务 → 按金额分档
// （不足 10 万品类经理；10–100 万品类经理 → 采购总监；100 万及以上再加总经理，示例档位）→ 签署中。
// 驳回 → 审批未通过；法务退回 → 改完重新提交；撤回 → 草稿；起草人、提交人和各级审批人不能是同一人。
// 测试数据全部在这里生成（示例公司名），不依赖外部样本。
describe('contract approval', () => {
  let stack: VerifyStack;
  let seq = 0;

  type Person = { token: string; id: string };
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`cta-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const contract = async (id: string) => (await stack.rows(Contract.name, { id }))[0]!;

  const supplier = async () => {
    const n = ++seq;
    return (
      (await stack.hooks.run(
        Supplier.name,
        'insert',
        { name: `示例合同审批测试有限公司 ${n}`, credit_code: `91000000MA0CTA${String(n).padStart(4, '0')}`, legacy_imported: true },
        { system: true },
      )) as { id: string }
    ).id;
  };
  // 起草：品类经理起草；as 为 null 时以系统身份建草稿，相当于自动续签生成的续签草稿（起草人不是品类经理）
  const draft = async (as: Person | null, doc: Record<string, unknown>) => {
    const fields = {
      title: `示例采购合同 ${++seq}`,
      contract_type: 'purchase',
      supplier: await supplier(),
      start_date: day(0),
      end_date: day(365),
      legal_reviewer: legal.id,
      ...doc,
    };
    const created = as
      ? stack.hooks.run(Contract.name, 'insert', fields, { as: as.token })
      : stack.hooks.run(Contract.name, 'insert', fields, { system: true });
    return (await created) as { id: string };
  };

  // 启动 screen flow 并在确认页提交；拒绝时返回 end 节点的结果
  const submit = async (as: Person, recordId: string) => {
    const started = (await stack.actions.run(Contract.name, 'srm_contract_submit', { as: as.token, recordId })) as {
      runId?: string;
      status?: string;
    };
    if (started.status !== 'paused' || !started.runId) return started;
    return stack.flows.resume({ flowName: 'srm_contract_submit', runId: started.runId }, {}, { as: as.token });
  };
  const draftAndSubmit = async (as: Person, doc: Record<string, unknown>, drafter: Person | null = as) => {
    const created = await draft(drafter, doc);
    await submit(as, created.id);
    expect((await contract(created.id)).status).toBe('in_review');
    return created.id;
  };

  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  // 当前这一级的待审批人（岗位或字段解析出的人）
  const pendingApprovers = async (recordId: string) => String((await pending(recordId))?.pending_approvers ?? '');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject' | 'revise', comment: string = verdict) => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
    return req!;
  };

  let legal: Person;
  let otherLegal: Person;
  let manager: Person;
  let otherManager: Person;
  let buyerLead: Person;
  let director: Person;
  let gm: Person;

  beforeAll(async () => {
    stack = await bootStack(config);
    legal = await person('srm_legal_counsel');
    otherLegal = await person('srm_legal_counsel');
    manager = await person('srm_category_manager');
    otherManager = await person('srm_category_manager');
    buyerLead = await person('srm_buyer_lead');
    director = await person('srm_procurement_director');
    gm = await person('srm_general_manager');
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('records the submitter and refuses a contract without an amount', async () => {
    const noAmount = await draft(manager, {});
    expect(JSON.stringify(await submit(manager, noAmount.id))).toContain('Enter the contract amount first');
    expect((await contract(noAmount.id)).status).toBe('draft');

    const id = await draftAndSubmit(manager, { amount: 50_000 });
    expect((await contract(id)).submitted_by).toBe(manager.id);
    expect(await pendingApprovers(id)).toContain(legal.id);
  });

  it('does not let the drafter name themselves as legal reviewer', async () => {
    await expect(draft(manager, { amount: 50_000, legal_reviewer: manager.id })).rejects.toThrow();
  });

  it('below the mid tier: legal, then a category manager', async () => {
    // 续签草稿由采购主管提交：起草人、提交人都不是品类经理，法务 → 品类经理
    const id = await draftAndSubmit(buyerLead, { amount: 50_000 }, null);
    await decide(legal, id, 'approve');
    expect(await pendingApprovers(id)).toContain(manager.id);
    await decide(manager, id, 'approve');
    expect(await contract(id)).toMatchObject({
      status: 'signing',
      approval_status: 'approved',
      legal_approver: legal.id,
      category_approver: manager.id,
    });
    expect((await contract(id)).director_approver ?? null).toBeNull();
  });

  it('below the mid tier, drafted by a category manager: the director approves instead', async () => {
    const id = await draftAndSubmit(manager, { amount: 50_000 });
    await decide(legal, id, 'approve');
    expect(await pendingApprovers(id)).toContain(director.id);
    await decide(director, id, 'approve');
    expect(await contract(id)).toMatchObject({ status: 'signing', director_approver: director.id });
    expect((await contract(id)).category_approver ?? null).toBeNull();
  });

  it('mid tier: legal → category manager → director', async () => {
    const id = await draftAndSubmit(buyerLead, { amount: 500_000 }, null);
    await decide(legal, id, 'approve');
    await decide(otherManager, id, 'approve');
    expect((await contract(id)).status).toBe('in_review');
    expect(await pendingApprovers(id)).toContain(director.id);
    await decide(director, id, 'approve');
    expect(await contract(id)).toMatchObject({
      status: 'signing',
      category_approver: otherManager.id,
      director_approver: director.id,
    });
  });

  it('high tier: legal → category manager → director → general manager', async () => {
    const id = await draftAndSubmit(buyerLead, { amount: 2_000_000 }, null);
    await decide(legal, id, 'approve');
    await decide(manager, id, 'approve');
    await decide(director, id, 'approve');
    expect((await contract(id)).status).toBe('in_review');
    expect(await pendingApprovers(id)).toContain(gm.id);
    await decide(gm, id, 'approve');
    expect(await contract(id)).toMatchObject({ status: 'signing', gm_approver: gm.id });
    // 提交人收到审批通过的站内信
    await expect
      .poll(async () => (await stack.rows('sys_inbox_message', { user_id: buyerLead.id })).some((m) => String(m.action_url).endsWith(`/${id}`)))
      .toBe(true);
  });

  it('rejects with the reason written on the contract', async () => {
    const id = await draftAndSubmit(manager, { amount: 500_000 });
    await decide(legal, id, 'approve');
    await decide(director, id, 'reject', '付款条款不符合公司规定');
    expect(await contract(id)).toMatchObject({ status: 'rejected', reject_reason: '付款条款不符合公司规定' });
  });

  it('lets legal send it back; the submitter edits it and resubmits from legal', async () => {
    const id = await draftAndSubmit(manager, { amount: 50_000 });
    const first = await decide(legal, id, 'revise', '违约责任条款缺失');
    expect(await contract(id)).toMatchObject({ status: 'in_review', approval_status: 'returned' });

    // 退回期间合同内容和明细解锁
    await stack.hooks.run(Contract.name, 'update', { id, title: '示例采购合同（已补违约责任）' }, { as: manager.token });
    await stack.hooks.run(ContractLine.name, 'insert', { contract: id, line_no: 1, description: '示例物资', quantity: 10, unit_price: 100 }, { as: manager.token });

    const res = await stack.apiAs(manager.token, 'POST', `/approvals/requests/${first.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await contract(id)).approval_status).toBe('pending');
    expect(await pendingApprovers(id)).toContain(legal.id);
    await expect(stack.hooks.run(Contract.name, 'update', { id, title: '审批中不能改' }, { as: manager.token })).rejects.toThrow();

    await decide(legal, id, 'approve');
    await decide(director, id, 'approve');
    expect(await contract(id)).toMatchObject({ status: 'signing', title: '示例采购合同（已补违约责任）' });
  });

  // 法务之后的一级退回：提交人仍是本人（objectstack#24817 随 18.1.0 修复），重新提交后从法务重来并按新金额分档
  it('lets a later level send it back; the submitter resubmits from legal and the new amount picks the levels', async () => {
    const id = await draftAndSubmit(buyerLead, { amount: 2_000_000 }, null);
    await decide(legal, id, 'approve');
    await decide(manager, id, 'approve');
    await decide(director, id, 'approve');
    const returned = await decide(gm, id, 'revise', '金额超出年度预算，请拆分');
    expect(returned.submitter_id).toBe(buyerLead.id);
    expect(await contract(id)).toMatchObject({ status: 'in_review', approval_status: 'returned' });

    await stack.hooks.run(Contract.name, 'update', { id, amount: 500_000, title: '示例采购合同（拆分后）' }, { as: buyerLead.token });
    const res = await stack.apiAs(buyerLead.token, 'POST', `/approvals/requests/${returned.id}/resubmit`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await pendingApprovers(id)).toContain(legal.id);

    await decide(legal, id, 'approve');
    // 上一轮后面几级的审批人作废
    expect(await contract(id)).toMatchObject({ legal_approver: legal.id, category_approver: null, director_approver: null, gm_approver: null });
    await decide(manager, id, 'approve');
    expect((await pending(id))!.submitter_id).toBe(buyerLead.id);
    await decide(director, id, 'approve');
    // 改成 mid 档后不再经总经理
    expect(await contract(id)).toMatchObject({ status: 'signing', director_approver: director.id, gm_approver: null });
    // 通知里是改过的标题
    await expect
      .poll(async () => (await stack.rows('sys_inbox_message', { user_id: buyerLead.id })).some((m) => JSON.stringify(m).includes('示例采购合同（拆分后）')))
      .toBe(true);
  });

  it('puts a recalled contract back to draft', async () => {
    const id = await draftAndSubmit(manager, { amount: 50_000 });
    const req = await pending(id);
    const res = await stack.apiAs(manager.token, 'POST', `/approvals/requests/${req!.id}/recall`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await contract(id)).status).toBe('draft');
    // 改完可以再次提交
    await stack.hooks.run(Contract.name, 'update', { id, amount: 60_000 }, { as: manager.token });
    await submit(manager, id);
    expect((await contract(id)).status).toBe('in_review');
    expect(await pendingApprovers(id)).toContain(legal.id);
  });

  it('puts a contract recalled while sent back to draft', async () => {
    const id = await draftAndSubmit(manager, { amount: 50_000 });
    const returned = await decide(legal, id, 'revise', '改用新范本');
    const res = await stack.apiAs(manager.token, 'POST', `/approvals/requests/${returned.id}/recall`, {});
    expect(res.status, await res.clone().text()).toBe(200);
    await expect.poll(async () => (await contract(id)).status).toBe('draft');
  });

  it('does not count an approval by the drafter or by the previous level', async () => {
    // 采购主管兼采购总监提交：采购总监一级他自己的通过不算数，要另一位采购总监
    const leadDirector = await person('srm_buyer_lead', 'srm_procurement_director');
    const id = await draftAndSubmit(leadDirector, { amount: 500_000 }, null);
    await decide(legal, id, 'approve');
    await decide(manager, id, 'approve');
    await decide(leadDirector, id, 'approve');
    expect((await contract(id)).status).toBe('in_review');
    expect((await contract(id)).director_approver ?? null).toBeNull();
    await expect
      .poll(async () => (await stack.rows('sys_inbox_message', { user_id: leadDirector.id })).some((m) => String(m.title).includes('另一位采购总监')))
      .toBe(true);
    await decide(director, id, 'approve');
    expect(await contract(id)).toMatchObject({ status: 'signing', director_approver: director.id });

    // 法务兼品类经理：法务一级通过后，品类经理一级不能还是他
    const legalManager = await person('srm_legal_counsel', 'srm_category_manager');
    const second = await draftAndSubmit(buyerLead, { amount: 50_000, legal_reviewer: legalManager.id }, null);
    await decide(legalManager, second, 'approve');
    await decide(legalManager, second, 'approve');
    expect((await contract(second)).status).toBe('in_review');
    await decide(otherManager, second, 'approve');
    expect(await contract(second)).toMatchObject({ status: 'signing', legal_approver: legalManager.id, category_approver: otherManager.id });
  });

  it('falls back to the legal counsel position when no legal reviewer is named', async () => {
    const id = await draftAndSubmit(manager, { amount: 50_000, legal_reviewer: null });
    const approvers = await pendingApprovers(id);
    expect(approvers).toContain(legal.id);
    expect(approvers).toContain(otherLegal.id);
  });
});
