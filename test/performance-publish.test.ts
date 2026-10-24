import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, DeliveryRecord, Kpi, Material, PerformanceReview, PerformanceScore, Supplier, SupplierCategory } from '../src/core/objects';
import { APPEAL_DAYS, GRADE_MIN, MISSING_SCORE, SCORE_DAYS } from '../src/core/flows/performance/params';

// v0.5 P3 人工评分、汇总分级、审定发布与申诉（02 §4.7、§5.7，03 §10 第 3–5、7 步，FR-703、704、706）：
// 生成时按指标的评分人类型从品类上指派评分人；评分人经「提交评分」只看到并填写自己的评分项；截止后缺评取默认分并标记未评；
// 全部评分完成后汇总分级、交采购总监审定，通过即发布并回写供应商等级，驳回即退回重评；发布后可代录申诉一次，采购总监处理。
// 测试数据全部在这里生成（示例公司名、示例品类），期间取 2031 年起，不与其他测试混在一起。
type Row = Record<string, unknown>;
type Person = { token: string; id: string };
type FlowResult = { status?: string; runId?: string; screen?: { title?: string }; success?: boolean; outcome?: string; message?: string };

describe('performance scoring, grading, publishing and appeals', () => {
  let stack: VerifyStack;
  let seq = 0;

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`pub-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const system = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as { id: string };
  const systemUpdate = (object: string, doc: Row) => stack.hooks.run(object, 'update', doc, { system: true });
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;

  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  const generate = async (asOf: string) => {
    const run = await stack.flows.run('srm_performance_generate', { asOf }, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  const sweep = async () => {
    const run = await stack.flows.run('srm_score_overdue_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  const reviewOf = async (supplier: string, period = '2031-01') => (await stack.rows(PerformanceReview.name, { supplier, period }))[0]!;
  const review = (id: string) => row(PerformanceReview.name, id);
  let codes: Map<string, string>;
  const linesOf = async (reviewId: string) =>
    Object.fromEntries((await stack.rows(PerformanceScore.name, { review: reviewId })).map((l) => [codes.get(String(l.kpi))!, l]));

  // 启动 screen flow；每停在一屏用 input(屏幕标题) 提交，直到结束；返回结束结果与经过的屏幕标题
  const runScreen = async (as: Person, flow: string, recordId: string, input: (title: string) => Row = () => ({})) => {
    let res = (await stack.actions.run(PerformanceReview.name, flow, { as: as.token, recordId })) as FlowResult;
    const titles: string[] = [];
    while (res.status === 'paused' && res.runId) {
      const title = String(res.screen?.title ?? '');
      titles.push(title);
      expect(titles.length, 'too many screens').toBeLessThan(20);
      res = (await stack.flows.resume({ flowName: flow, runId: res.runId }, input(title), { as: as.token })) as FlowResult;
    }
    return { res, titles };
  };
  // 拒绝时的提示（测试用户的界面语言是英文，取英文词条）
  const refusal = async (as: Person, flow: string, recordId: string) => {
    const { res, titles } = await runScreen(as, flow, recordId);
    expect(titles).toHaveLength(0);
    expect(res.status).toBe('refused');
    return String((res as { refusalMessage?: string }).refusalMessage ?? '');
  };
  // 按指标名称打分：名称 → 分数，没列的打 fallback
  const scoreAs = (as: Person, reviewId: string, byName: Record<string, number>, fallback = 75) =>
    runScreen(as, 'srm_score_submit', reviewId, (title) => {
      const name = Object.keys(byName).find((n) => title.includes(n));
      return { score: name ? byName[name] : fallback, score_note: `示例评分说明：${title}` };
    });

  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const pendingApprovers = async (recordId: string) => String((await pending(recordId))?.pending_approvers ?? '');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject', comment: string = verdict) => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const inbox = async (userId: string, recordId: string) =>
    (await stack.rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));

  let cm: Person;
  let buyer: Person;
  let sqe: Person;
  let director: Person;
  let otherDirector: Person;
  let scoringDirector: Person;
  let lead: Person;
  let material: string;

  const category = async (people: Row) => {
    const n = ++seq;
    return (await system(Category.name, { code: `PUB${n}`, name: `示例发布品类 ${n}`, material_class: 'class_a', ...people })).id;
  };
  const vendor = async (categoryId: string) => {
    const n = ++seq;
    const { id } = await system(Supplier.name, {
      name: `示例绩效发布有限公司 ${n}`,
      credit_code: `91000000MA0PUB${String(n).padStart(4, '0')}`,
      legacy_imported: true,
    });
    await system(SupplierCategory.name, { supplier: id, category: categoryId, status: 'qualified' });
    return id;
  };
  // 本期 10 行交付记录，全部准时、合格、无不良：三项自动指标都是满分
  const deliverAll = async (supplier: string, month: string) => {
    for (let i = 0; i < 10; i++) {
      await system(DeliveryRecord.name, {
        erp_receipt_no: `PUB${String(++seq).padStart(7, '0')}`,
        erp_order_no: '4500091001',
        erp_line_no: '10',
        supplier,
        material,
        required_date: `${month}-10`,
        receipt_date: `${month}-10`,
        received_quantity: 1000,
        inspection_result: 'pass',
      });
    }
  };

  const v: Record<string, string> = {};

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    codes = new Map((await stack.rows(Kpi.name, {})).map((k) => [String(k.id), String(k.code)]));
    material = (await system(Material.name, { erp_material_no: 'PUB-0001', material_code: 'PUB-0001', name: '示例发布物料' })).id;
    cm = await person('srm_category_manager');
    buyer = await person('srm_buyer');
    sqe = await person('srm_sqe');
    director = await person('srm_procurement_director');
    otherDirector = await person('srm_procurement_director');
    scoringDirector = await person('srm_procurement_director');
    lead = await person('srm_buyer_lead');

    const full = await category({ category_manager: cm.id, buyer: buyer.id, sqe: sqe.id });
    const noBuyer = await category({ category_manager: cm.id, sqe: sqe.id });
    // 采购总监兼这个品类的品类经理：价格竞争力由他评分，他不能审定这张考评单
    const directorScored = await category({ category_manager: scoringDirector.id, buyer: buyer.id, sqe: sqe.id });

    for (const name of ['main', 'reject', 'appeal', 'appealLate', 'void', 'older'] as const) {
      v[name] = await vendor(full);
      await deliverAll(v[name], '2031-01');
    }
    v.noBuyer = await vendor(noBuyer);
    await deliverAll(v.noBuyer, '2031-01');
    v.sod = await vendor(directorScored);
    await deliverAll(v.sod, '2031-01');
    // 没有交付记录：自动指标没有数据，交给评分人
    for (const name of ['empty', 'grade90', 'grade8999', 'grade70', 'grade6999'] as const) v[name] = await vendor(full);

    await generate('2031-02-02');
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('takes the grade lines, scoring period, missing score and appeal period from the parameters', () => {
    const yaml = readFileSync(new URL('../params/core.yaml', import.meta.url), 'utf8');
    const example = (key: string) => /example:\s*(.+)/.exec(yaml.split(/\n(?=\S)/).find((b) => b.startsWith(`${key}:`))!)![1]!.trim();
    expect(example('perf_grade_min')).toBe(`{ A: ${GRADE_MIN.A}, B: ${GRADE_MIN.B}, C: ${GRADE_MIN.C} }`);
    expect(Number(example('perf_score_days'))).toBe(SCORE_DAYS);
    expect(Number(example('perf_missing_score'))).toBe(MISSING_SCORE);
    expect(Number(example('perf_appeal_days'))).toBe(APPEAL_DAYS);
  });

  it('assigns each manual or data-less line a scorer by the KPI scorer type and notifies the scorers', async () => {
    const r = await reviewOf(v.main!);
    expect(r).toMatchObject({ status: 'scoring', score_due: day(SCORE_DAYS), data_incomplete: false });
    const lines = await linesOf(String(r.id));
    expect(lines.PLAN_FULFIL!.scorer).toBe(buyer.id);
    expect(lines.SERVICE!.scorer).toBe(buyer.id);
    expect(lines.PRICE!.scorer).toBe(cm.id);
    expect(lines.SAFETY_ENV!.scorer).toBe(sqe.id);
    // 算出得分的自动指标不需要评分人
    for (const code of ['LOT_PASS', 'PPM', 'OTD']) expect(lines[code]).toMatchObject({ scored: true, score: 100 });
    for (const code of ['LOT_PASS', 'PPM', 'OTD']) expect(lines[code]!.scorer ?? null).toBeNull();
    for (const who of [buyer, cm, sqe]) await expect.poll(async () => (await inbox(who.id, String(r.id))).length).toBe(1);
  });

  it('falls back to the category manager when the category has no person of that type', async () => {
    const lines = await linesOf(String((await reviewOf(v.noBuyer!)).id));
    expect(lines.PLAN_FULFIL!.scorer).toBe(cm.id);
    expect(lines.SERVICE!.scorer).toBe(cm.id);
    expect(lines.SAFETY_ENV!.scorer).toBe(sqe.id);
  });

  it('gives automatic KPIs without data to a scorer instead of a zero', async () => {
    const r = await reviewOf(v.empty!);
    expect(r).toMatchObject({ status: 'scoring', data_incomplete: true, delivery_count: 0 });
    const lines = await linesOf(String(r.id));
    expect(lines.LOT_PASS).toMatchObject({ scored: false, scorer: sqe.id });
    expect(lines.PPM).toMatchObject({ scored: false, scorer: sqe.id });
    expect(lines.OTD).toMatchObject({ scored: false, scorer: buyer.id });
    expect(lines.OTD!.score ?? null).toBeNull();
  });

  it('shows a scorer only the lines assigned to them and refuses someone with none', async () => {
    const r = await reviewOf(v.main!);
    const id = String(r.id);
    const { res, titles } = await scoreAs(buyer, id, { 计划完成率: 80, 响应与配合: 80 });
    expect(titles).toHaveLength(2);
    expect(titles.some((t) => t.includes('计划完成率'))).toBe(true);
    expect(titles.some((t) => t.includes('响应与配合'))).toBe(true);
    expect(res.status).not.toBe('failed');
    const lines = await linesOf(id);
    expect(lines.PLAN_FULFIL).toMatchObject({ score: 80, scored: true });
    expect(String(lines.PLAN_FULFIL!.comment)).toContain('示例评分说明');
    // 别人的评分项不动
    expect(lines.PRICE!.scored).toBe(false);
    expect((await review(id)).status).toBe('scoring');

    // 没有指派给本人的评分项
    const outsider = await person('srm_buyer');
    const refused = await runScreen(outsider, 'srm_score_submit', id);
    expect(refused.titles).toHaveLength(0);
    expect(refused.res).toMatchObject({ status: 'refused', refusalMessage: expect.stringContaining('No score lines of this review are assigned to you') });

    // 评分明细对评分人也是只读：绕过界面直接改不了
    await expect(
      stack.hooks.run(PerformanceScore.name, 'update', { id: String(lines.PRICE!.id), score: 100, scored: true }, { as: buyer.token }),
    ).rejects.toThrow();
    expect((await linesOf(id)).PRICE!.scored).toBe(false);
  });

  it('grades the review once all lines are scored and publishes it on the director\'s approval', async () => {
    const id = String((await reviewOf(v.main!)).id);
    await scoreAs(cm, id, { 价格竞争力: 85 });
    expect((await review(id)).status).toBe('scoring');
    await scoreAs(sqe, id, { 安全环保合规: 90 });

    const graded = await review(id);
    // 20 + 10 + 15（自动满分）+ 8 + 8 + 17 + 13.5
    expect(graded).toMatchObject({ status: 'reviewing', total_score: 91.5, grade: 'grade_a', approval_status: 'pending' });
    expect(graded).toMatchObject({ quality_score: 100, delivery_score: 92, cost_score: 85, service_score: 80, hse_score: 90 });
    expect(await pendingApprovers(id)).toContain(director.id);

    await decide(director, id, 'approve', '同意发布');
    expect(await review(id)).toMatchObject({ status: 'published', reviewer: director.id, review_comment: '同意发布', published_date: day(0) });
    expect(await row(Supplier.name, v.main!)).toMatchObject({ grade: 'grade_a', latest_score: 91.5 });
    await expect.poll(async () => (await inbox(buyer.id, id)).length).toBe(2);
  });

  it('grades by the parameter lines at the exact boundaries', async () => {
    const cases: Array<[string, number, string]> = [
      ['grade90', 90, 'grade_a'],
      ['grade8999', 89.99, 'grade_b'],
      ['grade70', 70, 'grade_c'],
      ['grade6999', 69.99, 'grade_d'],
    ];
    for (const [name, value, grade] of cases) {
      const id = String((await reviewOf(v[name]!)).id);
      for (const who of [buyer, cm]) await scoreAs(who, id, {}, value);
      // 评分说明可以不填
      await runScreen(sqe, 'srm_score_submit', id, () => ({ score: value }));
      expect(await review(id), name).toMatchObject({ status: 'reviewing', total_score: value, grade });
      expect((await linesOf(id)).SAFETY_ENV!.comment ?? null).toBeNull();
    }
  });

  it('defaults missing scores after the due date, marks them not scored and moves on to review', async () => {
    const id = String((await reviewOf(v.empty!)).id);
    await scoreAs(cm, id, { 价格竞争力: 80 });
    // 截止日没到时扫描不处理
    await sweep();
    expect((await review(id)).status).toBe('scoring');

    await systemUpdate(PerformanceReview.name, { id, score_due: day(-1) });
    await sweep();
    const lines = await linesOf(id);
    expect(lines.PRICE).toMatchObject({ score: 80, scored: true, defaulted: false });
    for (const code of ['LOT_PASS', 'PPM', 'OTD', 'PLAN_FULFIL', 'SERVICE', 'SAFETY_ENV']) {
      expect(lines[code], code).toMatchObject({ score: MISSING_SCORE, scored: true, defaulted: true });
    }
    // 0.2 × 80 + 0.8 × 60
    expect(await review(id)).toMatchObject({ status: 'reviewing', total_score: 64, grade: 'grade_d' });
    // 再扫一次不重复处理
    await sweep();
    expect((await review(id)).status).toBe('reviewing');
  });

  it('reminds scorers with open lines three days before the due date', async () => {
    const id = String((await reviewOf(v.void!)).id);
    await systemUpdate(PerformanceReview.name, { id, score_due: day(3) });
    const before = (await inbox(cm.id, id)).length;
    const job = stack.kernel.getService<{ trigger(name: string): Promise<unknown> }>('job');
    await job.trigger('flow-time-relative:srm_score_due_notice');
    await expect.poll(async () => (await inbox(cm.id, id)).length).toBe(before + 1);
  });

  it('does not count the approval of a director who scored the review', async () => {
    const id = String((await reviewOf(v.sod!)).id);
    for (const who of [buyer, scoringDirector, sqe]) await scoreAs(who, id, {}, 85);
    expect((await review(id)).status).toBe('reviewing');
    await decide(scoringDirector, id, 'approve');
    expect((await review(id)).status).toBe('reviewing');
    await expect
      .poll(async () => (await stack.rows('sys_inbox_message', { user_id: scoringDirector.id })).some((m) => String(m.title).includes('另一位采购总监')))
      .toBe(true);
    expect(await pendingApprovers(id)).toContain(otherDirector.id);
    await decide(otherDirector, id, 'approve');
    expect(await review(id)).toMatchObject({ status: 'published', reviewer: otherDirector.id });
  });

  it('sends a review back for rescoring when the director rejects it', async () => {
    const id = String((await reviewOf(v.reject!)).id);
    for (const who of [buyer, cm, sqe]) await scoreAs(who, id, {}, 75);
    await systemUpdate(PerformanceReview.name, { id, score_due: day(-2) });
    // 自动指标满分 45 + 0.55 × 75
    expect((await review(id)).total_score).toBe(86.25);
    await decide(director, id, 'reject', '价格竞争力偏高，请品类经理复核');
    expect(await review(id)).toMatchObject({ status: 'scoring', review_comment: '价格竞争力偏高，请品类经理复核', score_due: day(SCORE_DAYS) });
    await expect.poll(async () => (await inbox(cm.id, id)).length).toBe(2);

    // 品类经理改分：屏幕带出原来的分数，改完考评单再次转审定中，重新汇总
    const started = (await stack.actions.run(PerformanceReview.name, 'srm_score_submit', { as: cm.token, recordId: id })) as FlowResult & {
      screen?: { fields?: Array<{ name: string; defaultValue?: unknown }> };
    };
    expect(started.screen?.fields?.find((f) => f.name === 'score')?.defaultValue).toBe(75);
    await stack.flows.resume({ flowName: 'srm_score_submit', runId: started.runId! }, { score: 10 }, { as: cm.token });
    const titles = [started.screen?.title];
    expect(titles).toHaveLength(1);
    expect((await linesOf(id)).PRICE).toMatchObject({ score: 10, scored: true });
    const again = await review(id);
    expect(again).toMatchObject({ status: 'reviewing', total_score: 73.25, grade: 'grade_c', approval_status: 'pending' });
    await decide(director, id, 'approve');
    expect((await review(id)).status).toBe('published');
  });

  it('does not overwrite the supplier grade with an older period', async () => {
    await generate('2031-03-02');
    const newer = String((await reviewOf(v.older!, '2031-02')).id);
    const older = String((await reviewOf(v.older!, '2031-01')).id);
    for (const who of [buyer, cm, sqe]) await scoreAs(who, newer, {}, 50);
    await decide(director, newer, 'approve');
    expect(await row(Supplier.name, v.older!)).toMatchObject({ grade: 'grade_d' });
    for (const who of [buyer, cm, sqe]) await scoreAs(who, older, {}, 95);
    await decide(director, older, 'approve');
    expect((await review(older)).status).toBe('published');
    expect(await row(Supplier.name, v.older!)).toMatchObject({ grade: 'grade_d' });
  });

  it('records one appeal within the appeal period and lets a director who did not score it adjust the result', async () => {
    const id = String((await reviewOf(v.appeal!)).id);
    // 自动指标满分 45 + 0.55 × 50
    for (const who of [buyer, cm, sqe]) await scoreAs(who, id, {}, 50);
    await decide(director, id, 'approve');
    expect(await row(Supplier.name, v.appeal!)).toMatchObject({ grade: 'grade_c', latest_score: 72.5 });

    // 评分人之外的岗位不能代录
    expect(await refusal(sqe, 'srm_appeal_submit', id)).toContain('Supplier appeals are recorded by');
    const { titles } = await runScreen(lead, 'srm_appeal_submit', id, () => ({ appeal_text: '示例申诉：本期两批让步接收已由客户确认合格' }));
    expect(titles).toHaveLength(1);
    expect(await review(id)).toMatchObject({
      status: 'appealed',
      appeal_reason: '示例申诉：本期两批让步接收已由客户确认合格',
      appeal_date: day(0),
      appeal_recorded_by: lead.id,
    });
    await expect.poll(async () => (await inbox(director.id, id)).length).toBeGreaterThan(0);

    // 处理人不能是评分人；只有采购总监处理
    await systemUpdate(PerformanceScore.name, { id: String((await linesOf(id)).PRICE!.id), scorer: scoringDirector.id });
    expect(await refusal(scoringDirector, 'srm_appeal_resolve', id)).toContain('You scored this review');
    expect(await refusal(cm, 'srm_appeal_resolve', id)).toContain('handled by the procurement director');

    await runScreen(director, 'srm_appeal_resolve', id, () => ({ outcome: 'adjusted', adjusted_score: 80.5, result_text: '示例：复核后计入两批合格' }));
    expect(await review(id)).toMatchObject({
      status: 'published',
      appeal_outcome: 'adjusted',
      appeal_result: '示例：复核后计入两批合格',
      appeal_handled_by: director.id,
      total_score: 80.5,
      grade: 'grade_b',
    });
    expect(await row(Supplier.name, v.appeal!)).toMatchObject({ grade: 'grade_b', latest_score: 80.5 });
    await expect.poll(async () => (await inbox(lead.id, id)).length).toBe(1);

    // 只能申诉一次
    expect(await refusal(lead, 'srm_appeal_submit', id)).toContain('appealed only once');
  });

  it('keeps the result when the director upholds it, and refuses an appeal after the appeal period', async () => {
    const id = String((await reviewOf(v.appealLate!)).id);
    for (const who of [buyer, cm, sqe]) await scoreAs(who, id, {}, 88);
    await decide(director, id, 'approve');
    await systemUpdate(PerformanceReview.name, { id, published_date: day(-APPEAL_DAYS - 1) });
    expect(await refusal(lead, 'srm_appeal_submit', id)).toContain(`within ${APPEAL_DAYS} days`);

    await systemUpdate(PerformanceReview.name, { id, published_date: day(-APPEAL_DAYS) });
    await runScreen(buyer, 'srm_appeal_submit', id, () => ({ appeal_text: '示例申诉' }));
    await runScreen(director, 'srm_appeal_resolve', id, () => ({ outcome: 'maintained', result_text: '示例：维持原结果' }));
    expect(await review(id)).toMatchObject({ status: 'published', appeal_outcome: 'maintained', total_score: 93.4, grade: 'grade_a' });
  });

  it('lets only the procurement director void a review in manual scoring', async () => {
    const id = String((await reviewOf(v.void!)).id);
    expect(await refusal(cm, 'srm_performance_void', id)).toContain('Only the procurement director can void');
    await runScreen(director, 'srm_performance_void', id, () => ({ reason_text: '示例：本期实际没有供货' }));
    expect(await review(id)).toMatchObject({ status: 'void', void_reason: '示例：本期实际没有供货' });
    expect(await refusal(buyer, 'srm_score_submit', id)).toContain('only while the review is in manual scoring');
  });
});
