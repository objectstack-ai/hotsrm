import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import {
  Category,
  Contract,
  Kpi,
  PerformanceReview,
  PerformanceScore,
  QualityIssue,
  Supplier,
  SupplierCategory,
  SupplierDisposition,
} from '../src/core/objects';
import { AUTO_APPLY, D_EXIT_PERIODS } from '../src/core/flows/performance/params';
import { performanceApplyFlow } from '../src/core/flows/performance/apply.flow';

// v0.5 P4 绩效结果应用（01 FR-705、BR-18，03 §10 第 6、7 步，07 D9）：考评单审定发布后，C 级开绩效改善整改单，D 级生成冻结
// 处置单草稿，连续 perf_d_exit_periods 期 D 级生成淘汰处置单草稿，A 级标优选；申诉处理不重新应用，改变等级时通知品类经理；
// 开关 perf_auto_apply 关闭时只通知。
// 测试数据全部在这里生成（示例公司名、示例品类），期间取 2033 年起，不与其他测试混在一起。考评单以系统身份建好一条
// 100% 权重的评分明细后转审定中，由采购总监审定发布，走真实的汇总分级与审定 flow。
type Row = Record<string, unknown>;
type Person = { token: string; id: string };
type Stack = VerifyStack;

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const monthEnd = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

const harness = (getStack: () => Stack, tag: string) => {
  let seq = 0;
  const stack = () => getStack();
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack().signUp(`${tag}-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack().contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack().seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const system = async (object: string, doc: Row) => (await stack().hooks.run(object, 'insert', doc, { system: true })) as { id: string };
  const systemUpdate = (object: string, doc: Row) => stack().hooks.run(object, 'update', doc, { system: true });
  const row = async (object: string, id: string) => (await stack().rows(object, { id }))[0]!;
  const pending = async (recordId: string) =>
    (await stack().rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject' = 'approve') => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack().apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment: verdict });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const inbox = async (userId: string, recordId: string) =>
    (await stack().rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));

  const category = async (people: Row) => {
    const n = ++seq;
    return (await system(Category.name, { code: `${tag.toUpperCase()}${n}`, name: `示例应用品类 ${tag} ${n}`, material_class: 'class_a', ...people })).id;
  };
  const vendor = async (categoryId: string) => {
    const n = ++seq;
    const { id } = await system(Supplier.name, {
      name: `示例绩效应用有限公司 ${tag} ${n}`,
      credit_code: `91000000MA0${tag.toUpperCase().padEnd(3, 'X').slice(0, 3)}${String(n).padStart(4, '0')}`,
      legacy_imported: true,
    });
    await system(SupplierCategory.name, { supplier: id, category: categoryId, status: 'qualified' });
    return id;
  };

  // 月度考评单：建好一条 100% 权重、得分 score 的评分明细，转审定中后由采购总监审定发布
  const publish = async (director: Person, supplier: string, month: number, score: number, year = 2033) => {
    const { id } = await system(PerformanceReview.name, {
      supplier,
      cycle: 'monthly',
      period: `${year}-${MONTHS[month - 1]}`,
      period_start: `${year}-${MONTHS[month - 1]}-01`,
      period_end: monthEnd(year, month),
      status: 'calculating',
    });
    const kpi = (await stack().rows(Kpi.name, {}))[0]!;
    await system(PerformanceScore.name, { review: id, kpi: kpi.id, weight: 1, score, scored: true });
    await systemUpdate(PerformanceReview.name, { id, status: 'scoring' });
    await systemUpdate(PerformanceReview.name, { id, status: 'reviewing' });
    await decide(director, id);
    expect((await row(PerformanceReview.name, id)).status).toBe('published');
    return id;
  };
  const scarsOf = (supplier: string) => stack().rows(QualityIssue.name, { supplier });
  const dispositionsOf = (supplier: string) => stack().rows(SupplierDisposition.name, { supplier });

  return { person, system, systemUpdate, row, decide, inbox, category, vendor, publish, scarsOf, dispositionsOf };
};

describe('performance result application', () => {
  let stack: VerifyStack;
  const h = harness(() => stack, 'apl');

  let cm: Person;
  let sqe: Person;
  let director: Person;
  let gm: Person;
  let buyer: Person;
  let otherCm: Person;
  let cat: string;

  // screen flow：启动后停在确认屏时提交 input
  const runScreen = async (as: Person, object: string, flow: string, recordId: string, input: Row = {}) => {
    const started = (await stack.actions.run(object, flow, { as: as.token, recordId })) as { runId?: string; status?: string };
    if (started.status !== 'paused' || !started.runId) return started;
    return stack.flows.resume({ flowName: flow, runId: started.runId }, input, { as: as.token });
  };
  const drafts = async (supplier: string) => (await h.dispositionsOf(supplier)).filter((d) => d.status === 'draft');

  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    cm = await h.person('srm_category_manager');
    otherCm = await h.person('srm_category_manager');
    sqe = await h.person('srm_sqe');
    director = await h.person('srm_procurement_director');
    gm = await h.person('srm_general_manager');
    buyer = await h.person('srm_buyer');
    cat = await h.category({ category_manager: cm.id, sqe: sqe.id });
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('takes the consecutive-D count and the auto-apply switch from the parameters', () => {
    const yaml = readFileSync(new URL('../params/core.yaml', import.meta.url), 'utf8');
    const example = (key: string) => /example:\s*(.+)/.exec(yaml.split(/\n(?=\S)/).find((b) => b.startsWith(`${key}:`))!)![1]!.trim();
    expect(Number(example('perf_d_exit_periods'))).toBe(D_EXIT_PERIODS);
    expect(example('perf_auto_apply') === '开启').toBe(AUTO_APPLY);
  });

  it('raises a performance SCAR for a C grade, with the category SQE responsible', async () => {
    const supplier = await h.vendor(cat);
    const review = await h.publish(director, supplier, 1, 75);
    expect(await h.row(PerformanceReview.name, review)).toMatchObject({ grade: 'grade_c', total_score: 75 });
    const scars = await h.scarsOf(supplier);
    expect(scars).toHaveLength(1);
    expect(scars[0]).toMatchObject({ source: 'performance', severity: 'minor', status: 'open', performance_review: review, sqe: sqe.id });
    expect(String(scars[0]!.problem_description)).toContain('C 级');
    await expect.poll(async () => (await h.inbox(sqe.id, String(scars[0]!.id))).length).toBe(1);
    await expect.poll(async () => (await h.inbox(cm.id, String(scars[0]!.id))).length).toBe(1);
    // C 级不生成处置单草稿，供应商不是优选
    expect(await h.dispositionsOf(supplier)).toHaveLength(0);
    expect(await h.row(Supplier.name, supplier)).toMatchObject({ grade: 'grade_c', preferred: false, status: 'qualified' });
  });

  it('marks an A-grade supplier preferred and clears it when a later period is not A', async () => {
    const supplier = await h.vendor(cat);
    await h.publish(director, supplier, 1, 95);
    expect(await h.row(Supplier.name, supplier)).toMatchObject({ grade: 'grade_a', preferred: true });
    expect(await h.scarsOf(supplier)).toHaveLength(0);
    expect(await h.dispositionsOf(supplier)).toHaveLength(0);
    await h.publish(director, supplier, 2, 85);
    expect(await h.row(Supplier.name, supplier)).toMatchObject({ grade: 'grade_b', preferred: false });
  });

  it('drafts a freeze for a D grade without submitting it', async () => {
    const supplier = await h.vendor(cat);
    const review = await h.publish(director, supplier, 1, 60);
    const list = await drafts(supplier);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ action: 'freeze', scope: 'all', status: 'draft', performance_review: review });
    expect(String(list[0]!.reason)).toContain(String((await h.row(PerformanceReview.name, review)).review_no));
    await expect.poll(async () => (await h.inbox(cm.id, String(list[0]!.id))).length).toBe(1);
    // 草稿不进审批，供应商状态不变；D 级不开整改单
    expect(await h.row(Supplier.name, supplier)).toMatchObject({ status: 'qualified', grade: 'grade_d' });
    expect(await h.scarsOf(supplier)).toHaveLength(0);
  });

  it('drafts an elimination after consecutive D grades, and the eliminated supplier cannot take a new contract', async () => {
    const supplier = await h.vendor(cat);
    await h.publish(director, supplier, 1, 50);
    const [freeze] = await drafts(supplier);
    // 品类经理提交冻结草稿：发起即品类经理一级，再经采购总监
    await runScreen(cm, SupplierDisposition.name, 'srm_disposition_submit', String(freeze!.id));
    await h.decide(director, String(freeze!.id));
    expect(await h.row(Supplier.name, supplier)).toMatchObject({ status: 'frozen' });

    // 冻结期间仍考评；第二期 D 级：连续两期，生成淘汰草稿（冻结的供应商不再生成冻结草稿）
    const second = await h.publish(director, supplier, 2, 55);
    const list = await drafts(supplier);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ action: 'eliminate', scope: 'all', performance_review: second });
    expect(String(list[0]!.reason)).toContain(`连续 ${D_EXIT_PERIODS} 期`);
    await expect.poll(async () => (await h.inbox(cm.id, String(list[0]!.id))).length).toBe(1);

    // 淘汰：品类经理提交 → 采购总监 → 总经理
    await runScreen(cm, SupplierDisposition.name, 'srm_disposition_submit', String(list[0]!.id));
    await h.decide(director, String(list[0]!.id));
    await h.decide(gm, String(list[0]!.id));
    expect(await h.row(SupplierDisposition.name, String(list[0]!.id))).toMatchObject({ status: 'applied' });
    expect(await h.row(Supplier.name, supplier)).toMatchObject({ status: 'eliminated' });
    // 门槛 1 第 7 步：淘汰的供应商不能关联新合同
    await expect(
      stack.hooks.run(
        Contract.name,
        'insert',
        { title: '示例框架协议（淘汰后）', contract_type: 'framework', supplier, start_date: '2033-03-01', end_date: '2034-02-28', amount: 100000 },
        { as: cm.token },
      ),
    ).rejects.toThrow(/qualified/);
  });

  it('does not count D grades with a missing period in between as consecutive, and reuses an existing freeze draft', async () => {
    const supplier = await h.vendor(cat);
    await h.publish(director, supplier, 1, 50);
    // 2 月没有考评单（如当期没有品类资格），3 月又是 D 级：不连续，仍是冻结；已有冻结草稿，不再建
    await h.publish(director, supplier, 3, 50);
    const list = await drafts(supplier);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ action: 'freeze' });
  });

  it('does not count a D after a C as consecutive', async () => {
    const supplier = await h.vendor(cat);
    await h.publish(director, supplier, 1, 75);
    await h.publish(director, supplier, 2, 50);
    expect((await drafts(supplier)).map((d) => d.action)).toEqual(['freeze']);
  });

  it('only notifies when the supplier already has a disposition in review', async () => {
    const supplier = await h.vendor(cat);
    const open = await stack.hooks.run(
      SupplierDisposition.name,
      'insert',
      { supplier, action: 'freeze', scope: 'all', reason: '示例：已在处置中' },
      { as: cm.token },
    ) as { id: string };
    expect((await h.row(SupplierDisposition.name, open.id)).status).toBe('in_review');
    const review = await h.publish(director, supplier, 1, 40);
    expect(await drafts(supplier)).toHaveLength(0);
    await expect.poll(async () => (await h.inbox(cm.id, review)).length).toBeGreaterThan(0);
  });

  it('does not apply again when an appeal is resolved, and tells the category manager when the grade changes', async () => {
    const supplier = await h.vendor(cat);
    const review = await h.publish(director, supplier, 1, 72);
    expect(await h.scarsOf(supplier)).toHaveLength(1);
    const inboxBefore = (await h.inbox(cm.id, review)).length;

    // 代录申诉，采购总监调整到 B 级：不再开整改单，通知品类经理核对原来的整改单
    await runScreen(buyer, PerformanceReview.name, 'srm_appeal_submit', review, { appeal_text: '示例申诉：价格得分有误' });
    expect((await h.row(PerformanceReview.name, review)).status).toBe('appealed');
    const other = await h.person('srm_procurement_director');
    await runScreen(other, PerformanceReview.name, 'srm_appeal_resolve', review, {
      outcome: 'adjusted',
      adjusted_score: 82,
      result_text: '示例：复核价格数据后调整',
    });
    expect(await h.row(PerformanceReview.name, review)).toMatchObject({ status: 'published', grade: 'grade_b' });
    expect(await h.scarsOf(supplier)).toHaveLength(1);
    expect(await h.dispositionsOf(supplier)).toHaveLength(0);
    await expect.poll(async () => (await h.inbox(cm.id, review)).length).toBe(inboxBefore + 1);
    // 不是本供应商品类经理的人不收到
    expect(await h.inbox(otherCm.id, review)).toHaveLength(0);
  });

  it('does not raise a second SCAR when the same review is published again', async () => {
    const supplier = await h.vendor(cat);
    const review = await h.publish(director, supplier, 1, 74);
    expect(await h.scarsOf(supplier)).toHaveLength(1);
    // 申诉维持原结果：回到已发布不触发结果应用
    await runScreen(buyer, PerformanceReview.name, 'srm_appeal_submit', review, { appeal_text: '示例申诉' });
    const other = await h.person('srm_procurement_director');
    await runScreen(other, PerformanceReview.name, 'srm_appeal_resolve', review, { outcome: 'maintained', result_text: '示例：维持' });
    expect(await h.row(PerformanceReview.name, review)).toMatchObject({ status: 'published', grade: 'grade_c' });
    expect(await h.scarsOf(supplier)).toHaveLength(1);
  });
});

// 07 D9：首年可以只发布不自动处置。开关关闭时发布后只通知品类经理
describe('performance result application switched off', () => {
  let stack: VerifyStack;
  const h = harness(() => stack, 'apf');
  let cm: Person;
  let director: Person;
  let cat: string;

  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    const flows = (config.flows ?? []).map((f) => (f.name === 'srm_performance_apply' ? performanceApplyFlow(false) : f));
    stack = await bootStack({ ...config, flows });
    cm = await h.person('srm_category_manager');
    director = await h.person('srm_procurement_director');
    cat = await h.category({ category_manager: cm.id });
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('only notifies the category manager for C and D grades', async () => {
    const c = await h.vendor(cat);
    const cReview = await h.publish(director, c, 1, 75);
    const d = await h.vendor(cat);
    const dReview = await h.publish(director, d, 1, 50);
    await h.publish(director, d, 2, 50);
    expect(await h.scarsOf(c)).toHaveLength(0);
    expect(await h.dispositionsOf(d)).toHaveLength(0);
    await expect.poll(async () => (await h.inbox(cm.id, cReview)).length).toBe(1);
    await expect.poll(async () => (await h.inbox(cm.id, dReview)).length).toBe(1);
    expect(await h.row(Supplier.name, d)).toMatchObject({ status: 'qualified', grade: 'grade_d' });
  });
});
