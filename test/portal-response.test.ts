import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import { uploadedFile } from './support/files';
import config from '../objectstack.config';
import { Category, Material, PerformanceReview, PerformanceScore, QualityIssue, Supplier, SupplierContact } from '../src/core/objects';

// v0.6 U5（#81）：供应商在门户回复整改单、确认索赔、查看已发布绩效并申诉（01 FR-603、606、704、706；03 §8 第 2–6 步、
// §10 第 5、7 步；04 §3.2）。门户用户按组织角色 external 邀请、任命静态岗位、登记在联系人 portal_user 上（同 PR #87 / #88
// 的准备步骤）。隔离（别家的单、不该改的字段和状态）在 test/portal-isolation.test.ts。测试数据全部在这里生成。
type Row = Record<string, any>;
type Person = { token: string; id: string };
type FlowResult = { status?: string; runId?: string; screen?: { title?: string }; refusalMessage?: string };

describe('portal SCAR reply, claim and performance appeal', () => {
  let stack: VerifyStack;
  let seq = 0;
  let org: Record<string, string> = {};

  const sys = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as Row;
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const assign = (userId: string, position: string) => stack.seed('sys_user_position', [{ user_id: userId, position, ...org }]);
  const person = async (position: string): Promise<Person> => {
    const token = await stack.signUp(`portal-reply-${position}-${++seq}@example.com`);
    const id = String((await stack.contextFor(token)).userId);
    await assign(id, position);
    return { token, id };
  };
  const portalUser = async (supplier: string, positions: string[], contactFunction: string[]): Promise<Person> => {
    const token = await stack.signUp(`portal-reply-${++seq}@example.com`);
    const id = String((await stack.contextFor(token)).userId);
    expect(await stack.hooks.updateWhere('sys_member', { user_id: id }, { role: 'external' }, { system: true })).toBe(1);
    for (const position of positions) await assign(id, position);
    await sys(SupplierContact.name, { supplier, name: `示例门户联系人 ${seq}`, email: `portal-reply-${seq}@example.com`, contact_function: contactFunction, portal_user: id });
    return { token, id };
  };
  const reply = (as: Person, id: string, doc: Row) => stack.hooks.run(QualityIssue.name, 'update', { id, ...doc }, { as: as.token });
  const file = (as?: string) => uploadedFile(stack, as, 'portal-evidence');
  // 站内信经消息服务异步投递：等到收齐 count 条（或超时）再读
  const inbox = async (userId: string, recordId: string, count = 1) => {
    const read = async () => (await stack.rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));
    for (let i = 0; i < 40 && (await read()).length < count; i++) await new Promise((r) => setTimeout(r, 50));
    return read();
  };
  const pending = async (recordId: string) => (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject', comment: string) => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const runScreen = async (as: Person, object: string, flow: string, recordId: string, input: Row = {}) => {
    let res = (await stack.actions.run(object, flow, { as: as.token, recordId })) as FlowResult;
    let screens = 0;
    while (res.status === 'paused' && res.runId) {
      expect(++screens, 'too many screens').toBeLessThan(5);
      res = (await stack.flows.resume({ flowName: flow, runId: res.runId }, input, { as: as.token })) as FlowResult;
    }
    return { res, screens };
  };
  const refusal = async (as: Person, object: string, flow: string, recordId: string) => {
    const { res, screens } = await runScreen(as, object, flow, recordId);
    expect(screens).toBe(0);
    expect(res.status).toBe('refused');
    return String(res.refusalMessage ?? '');
  };

  let sqe: Person;
  let accountant: Person;
  let director: Person;
  let supplier: string;
  let material: string;
  let x: Person;
  let xAdmin: Person;
  const scar = async (doc: Row = {}) =>
    String(
      (
        await sys(QualityIssue.name, {
          supplier,
          material,
          severity: 'major',
          problem_description: '示例：来料尺寸超差',
          sqe: sqe.id,
          ...doc,
        })
      ).id,
    );

  beforeAll(async () => {
    stack = await bootStack(config);
    const ctx = await stack.contextFor(await stack.signIn());
    org = ctx.tenantId ? { organization_id: String(ctx.tenantId) } : {};
    sqe = await person('srm_sqe');
    accountant = await person('srm_ap_accountant');
    director = await person('srm_procurement_director');
    const category = await sys(Category.name, { code: `PRP-${++seq}`, name: '示例品类（门户回复）', sqe: sqe.id });
    material = String((await sys(Material.name, { erp_material_no: `EX-PRP-${++seq}`, material_code: `M-PRP-${seq}`, name: '示例冲压件', category: category.id })).id);
    supplier = String((await sys(Supplier.name, { name: '示例门户回复有限公司', credit_code: '91000000MA0PRP0001', legacy_imported: true })).id);
    x = await portalUser(supplier, ['srm_portal_user'], ['quality']);
    xAdmin = await portalUser(supplier, ['srm_portal_user', 'srm_portal_admin'], ['admin']);
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
  });

  // 07 §2.2 第 1 步：X 在门户回复一张整改单并经 SQE 审核（退回一次、改好再通过）
  it('lets the supplier reply D3 and D4–D7 on the portal and the SQE review it', async () => {
    const id = await scar();
    const [seen] = await stack.rows(QualityIssue.name, { id }, { as: x.token });
    expect(seen).toMatchObject({ status: 'open', problem_description: '示例：来料尺寸超差' });

    // D3：可以先存草稿，再提交
    await reply(x, id, { containment_action: '示例：在库品全检隔离，在途批次加严检验' });
    expect((await row(QualityIssue.name, id)).status).toBe('open');
    await reply(x, id, { status: 'containment_submitted' });
    expect(await row(QualityIssue.name, id)).toMatchObject({ status: 'containment_submitted', containment_action: '示例：在库品全检隔离，在途批次加严检验' });
    expect(await inbox(sqe.id, id)).toHaveLength(1);

    // D4–D7 与证据，提交后由负责 SQE 审核（srm_scar_review），审核期间锁定
    const evidence = await file(x.token);
    await reply(x, id, {
      root_cause: '示例：模具磨损未按计划更换',
      corrective_action: '示例：更换模具并复测首件',
      preventive_action: '示例：模具寿命纳入点检表',
      evidence: [evidence],
    });
    await reply(x, id, { status: 'action_submitted' });
    expect((await row(QualityIssue.name, id)).status).toBe('action_submitted');
    expect(String((await pending(id))?.pending_approvers ?? '')).toContain(sqe.id);
    await expect(reply(x, id, { preventive_action: '审核中改' })).rejects.toBeTruthy();

    // SQE 退回：回到已提交临时措施，意见供应商可见
    await decide(sqe, id, 'reject', '示例：根因分析需附模具点检记录');
    const [returned] = await stack.rows(QualityIssue.name, { id }, { as: x.token });
    expect(returned).toMatchObject({ status: 'containment_submitted', sqe_comment: '示例：根因分析需附模具点检记录' });

    await reply(x, id, { root_cause: '示例：模具磨损未按计划更换，点检记录见附件', evidence: [await file(x.token)] });
    await reply(x, id, { status: 'action_submitted' });
    await decide(sqe, id, 'approve', '示例：同意');
    expect((await row(QualityIssue.name, id)).status).toBe('verifying');

    // 轮到 SQE 验证效果：供应商不能再改，也不能自己关闭
    await expect(reply(x, id, { corrective_action: '验证中改' })).rejects.toBeTruthy();
    await expect(reply(x, id, { status: 'closed' })).rejects.toBeTruthy();
    await stack.hooks.run(QualityIssue.name, 'update', { id, status: 'closed' }, { as: sqe.token });
    expect((await row(QualityIssue.name, id)).status).toBe('closed');
  });

  it('lets an SQE still record the reply for a supplier without portal access, without notifying itself', async () => {
    const id = await scar();
    await stack.hooks.run(QualityIssue.name, 'update', { id, containment_action: '示例：SQE 代填', status: 'containment_submitted' }, { as: sqe.token });
    expect((await row(QualityIssue.name, id)).status).toBe('containment_submitted');
    expect(await inbox(sqe.id, id)).toHaveLength(0);
  });

  // 03 §8 第 6 步：供应商接受或提出异议；接受后应付会计据此扣款并标记已扣款
  it('lets the supplier accept or dispute a proposed claim', async () => {
    const id = await scar();
    expect(await refusal(x, QualityIssue.name, 'srm_claim_respond', id)).toContain('Only a proposed claim');
    await stack.hooks.run(QualityIssue.name, 'update', { id, claim_amount: 5000, claim_status: 'proposed' }, { as: sqe.token });

    // 内部岗位不经这个 flow：线下确认的由 SQE 直接改索赔状态
    expect(await refusal(sqe, QualityIssue.name, 'srm_claim_respond', id)).toContain('confirmed by the supplier on the portal');
    // 门户不能直接改索赔状态
    await reply(x, id, { claim_status: 'supplier_accepted' }).catch(() => undefined);
    expect((await row(QualityIssue.name, id)).claim_status).toBe('proposed');

    await runScreen(x, QualityIssue.name, 'srm_claim_respond', id, { decision: 'dispute', response_text: '示例：不良数与我方出货检验记录不符' });
    expect(await row(QualityIssue.name, id)).toMatchObject({ claim_status: 'disputed', claim_response: '示例：不良数与我方出货检验记录不符' });
    expect(await inbox(sqe.id, id)).toHaveLength(1);
    expect(await refusal(x, QualityIssue.name, 'srm_claim_respond', id)).toContain('Only a proposed claim');

    // 协商后 SQE 调整金额重新提出，供应商接受
    await stack.hooks.run(QualityIssue.name, 'update', { id, claim_amount: 3000, claim_status: 'proposed' }, { as: sqe.token });
    await runScreen(x, QualityIssue.name, 'srm_claim_respond', id, { decision: 'accept' });
    expect((await row(QualityIssue.name, id)).claim_status).toBe('supplier_accepted');
    expect(await inbox(sqe.id, id, 2)).toHaveLength(2);
    expect(await inbox(accountant.id, id)).toHaveLength(1);
    await stack.hooks.run(QualityIssue.name, 'update', { id, claim_status: 'settled' }, { as: accountant.token });
    expect((await row(QualityIssue.name, id)).claim_status).toBe('settled');
  });

  // FR-704 / FR-706：已发布绩效与扣分项门户可见，门户管理员申诉一次
  it('shows the published review with its score lines and lets the portal admin appeal once', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [review] = await stack.seed(PerformanceReview.name, [
      { supplier, cycle: 'monthly', period: '2026-09', period_start: '2026-09-01', period_end: '2026-09-30', status: 'published', published_date: today, total_score: 76.5, grade: 'grade_c', quality_score: 70, reviewer: director.id, review_comment: '示例：内部审定意见' },
    ]);
    const id = String(review!.id);
    const kpi = String((await stack.rows('srm_kpi'))[0]!.id);
    await stack.seed(PerformanceScore.name, [{ review: id, kpi, raw_value: 92, score: 60, scored: true, scorer: sqe.id, comment: '示例：两批让步接收扣分' }]);

    const [seen] = await stack.rows(PerformanceReview.name, { id }, { as: x.token });
    expect(seen).toMatchObject({ total_score: 76.5, grade: 'grade_c', quality_score: 70 });
    expect(seen!.review_comment ?? null).toBeNull();
    expect(seen!.reviewer ?? null).toBeNull();
    const [line] = await stack.rows(PerformanceScore.name, { review: id }, { as: x.token });
    expect(line).toMatchObject({ raw_value: 92, score: 60, comment: '示例：两批让步接收扣分' });
    expect(line!.scorer ?? null).toBeNull();
    // 隐藏字段不影响门户的列表搜索（objectstack#25672 只涉及选项字段）
    const search = await stack.apiAs(x.token, 'GET', `/data/${PerformanceReview.name}?search=2026-09`);
    expect(search.status, await search.clone().text()).toBe(200);

    // 普通门户用户不能申诉，门户管理员可以
    expect(await refusal(x, PerformanceReview.name, 'srm_appeal_submit', id)).toContain('portal administrator');
    await runScreen(xAdmin, PerformanceReview.name, 'srm_appeal_submit', id, { appeal_text: '示例申诉：两批让步接收已由客户确认合格' });
    expect(await row(PerformanceReview.name, id)).toMatchObject({
      status: 'appealed',
      appeal_reason: '示例申诉：两批让步接收已由客户确认合格',
      appeal_date: today,
      appeal_recorded_by: xAdmin.id,
    });
    expect(await inbox(director.id, id)).toHaveLength(1);
    // 申诉期间照常可见
    expect(await stack.rows(PerformanceReview.name, { id }, { as: x.token })).toHaveLength(1);

    // 采购总监处理后回到已发布，处理结果门户可见；只能申诉一次
    await runScreen(director, PerformanceReview.name, 'srm_appeal_resolve', id, { outcome: 'maintained', result_text: '示例：维持原结果' });
    const [resolved] = await stack.rows(PerformanceReview.name, { id }, { as: x.token });
    expect(resolved).toMatchObject({ status: 'published', appeal_outcome: 'maintained', appeal_result: '示例：维持原结果' });
    expect(await inbox(xAdmin.id, id)).toHaveLength(1);
    expect(await refusal(xAdmin, PerformanceReview.name, 'srm_appeal_submit', id)).toContain('appealed only once');
  });
});
