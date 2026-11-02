import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, DeliveryRecord, Kpi, Material, PerformanceReview, PerformanceScore, Supplier, SupplierCategory } from '../src/core/objects';

// 评分人回避改派（#65，03 §10 第 3 步，GL-06 6.4.5）：考评单生成后评分人需要回避的，采购总监在评分项上「改派评分人」，
// 原评分人的分数作废，替代人员经「提交评分」重新评分；原评分人、改派人、原因和日期留在评分项上。
// 测试数据全部在这里生成（示例公司名、示例品类），期间取 2032 年，不与其他测试混在一起。
type Row = Record<string, unknown>;
type Person = { token: string; id: string };
type FlowResult = { status?: string; runId?: string; screen?: { title?: string; description?: string }; refusalMessage?: string };

describe('performance scorer reassignment for recusal', () => {
  let stack: VerifyStack;
  let seq = 0;

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`rsg-${positions.join('-') || 'none'}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    if (positions.length) {
      await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    }
    return { token, id: String(context.userId) };
  };
  const system = async (object: string, doc: Row) => (await stack.hooks.run(object, 'insert', doc, { system: true })) as { id: string };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const review = (id: string) => row(PerformanceReview.name, id);
  const reviewOf = async (supplier: string) => (await stack.rows(PerformanceReview.name, { supplier, period: '2032-01' }))[0]!;
  let codes: Map<string, string>;
  const linesOf = async (reviewId: string) =>
    Object.fromEntries((await stack.rows(PerformanceScore.name, { review: reviewId })).map((l) => [codes.get(String(l.kpi))!, l]));

  // 启动 screen flow；每停在一屏用 input 提交，直到结束
  const runScreen = async (as: Person, object: string, flow: string, recordId: string, input: Row = {}) => {
    let res = (await stack.actions.run(object, flow, { as: as.token, recordId })) as FlowResult;
    const titles: string[] = [];
    while (res.status === 'paused' && res.runId) {
      titles.push(String(res.screen?.title ?? ''));
      expect(titles.length, 'too many screens').toBeLessThan(20);
      res = (await stack.flows.resume({ flowName: flow, runId: res.runId }, input, { as: as.token })) as FlowResult;
    }
    return { res, titles };
  };
  const reassign = (as: Person, lineId: string, input: Row = {}) => runScreen(as, PerformanceScore.name, 'srm_score_reassign', lineId, input);
  const score = (as: Person, reviewId: string, value: number) =>
    runScreen(as, PerformanceReview.name, 'srm_score_submit', reviewId, { score: value, score_note: '示例评分说明' });
  const inbox = async (userId: string, recordId: string) =>
    (await stack.rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));

  let cm: Person;
  let buyer: Person;
  let sqe: Person;
  let director: Person;
  let substitute: Person;
  let material: string;
  const v: Record<string, string> = {};

  const category = async (people: Row) => {
    const n = ++seq;
    return (await system(Category.name, { code: `RSG${n}`, name: `示例改派品类 ${n}`, material_class: 'class_a', ...people })).id;
  };
  const vendor = async (categoryId: string) => {
    const n = ++seq;
    const { id } = await system(Supplier.name, {
      name: `示例评分回避有限公司 ${n}`,
      credit_code: `91000000MA0RSG${String(n).padStart(4, '0')}`,
      legacy_imported: true,
    });
    await system(SupplierCategory.name, { supplier: id, category: categoryId, status: 'qualified' });
    return id;
  };
  // 本期 10 行交付记录，全部准时、合格：三项自动指标系统算分，没有评分人
  const deliverAll = async (supplier: string) => {
    for (let i = 0; i < 10; i++) {
      await system(DeliveryRecord.name, {
        erp_receipt_no: `RSG${String(++seq).padStart(7, '0')}`,
        erp_order_no: '4500092001',
        erp_line_no: '10',
        supplier,
        material,
        required_date: '2032-01-10',
        receipt_date: '2032-01-10',
        received_quantity: 1000,
        inspection_result: 'pass',
      });
    }
  };

  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    codes = new Map((await stack.rows(Kpi.name, {})).map((k) => [String(k.id), String(k.code)]));
    material = (await system(Material.name, { erp_material_no: 'RSG-0001', material_code: 'RSG-0001', name: '示例改派物料' })).id;
    cm = await person('srm_category_manager');
    buyer = await person('srm_buyer');
    sqe = await person('srm_sqe');
    director = await person('srm_procurement_director');
    substitute = await person('srm_buyer_lead');

    const full = await category({ category_manager: cm.id, buyer: buyer.id, sqe: sqe.id });
    // 品类上没有任何评分人：人工评分项生成时不指派
    const nobody = await category({});
    v.main = await vendor(full);
    await deliverAll(v.main);
    v.unassigned = await vendor(nobody);
    await deliverAll(v.unassigned);

    const run = await stack.flows.run('srm_performance_generate', { asOf: '2032-02-02' }, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('lets only the procurement director reassign, and not an automatically scored line', async () => {
    const lines = await linesOf(String((await reviewOf(v.main!)).id));
    const refused = await reassign(cm, String(lines.PRICE!.id));
    expect(refused.titles).toHaveLength(0);
    expect(refused.res).toMatchObject({ status: 'refused', refusalMessage: expect.stringContaining('Only the procurement director') });

    // 自动算分的评分项没有评分人：按钮不显示，直接启动 flow 也拒绝
    expect(lines.OTD).toMatchObject({ scored: true, score: 100 });
    const auto = (await stack.flows.run('srm_score_reassign', { recordId: String(lines.OTD!.id) }, { as: director.token })) as FlowResult;
    expect(auto).toMatchObject({ status: 'refused', refusalMessage: expect.stringContaining('scored automatically') });
  });

  it('refuses the original scorer, the director themself and someone without an internal position', async () => {
    const id = String((await reviewOf(v.main!)).id);
    const price = String((await linesOf(id)).PRICE!.id);
    const outsider = await person();
    const compliance = await person('srm_procurement_compliance');
    for (const [who, message] of [
      [cm.id, 'cannot be the original scorer'],
      [director.id, 'cannot reassign a score line to yourself'],
      [outsider.id, 'must hold an internal SRM position'],
      [compliance.id, 'must hold an internal SRM position'],
    ] as const) {
      const { res, titles } = await reassign(director, price, { new_scorer: who, reason_text: '示例回避原因' });
      expect(titles).toHaveLength(1);
      expect(res, message).toMatchObject({ status: 'refused', refusalMessage: expect.stringContaining(message) });
    }
    expect((await linesOf(id)).PRICE).toMatchObject({ scorer: cm.id });
  });

  it('moves a scored line to the substitute, voids the original score and records the recusal', async () => {
    const id = String((await reviewOf(v.main!)).id);
    // 原评分人已经评过分
    await score(cm, id, 95);
    expect((await linesOf(id)).PRICE).toMatchObject({ score: 95, scored: true });

    const { res, titles } = await reassign(director, String((await linesOf(id)).PRICE!.id), {
      new_scorer: substitute.id,
      reason_text: '示例：原评分人的近亲属在该供应商任职',
    });
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain('价格竞争力');
    expect(res.status).not.toBe('refused');
    expect(res.status).not.toBe('failed');

    const price = (await linesOf(id)).PRICE!;
    expect(price).toMatchObject({
      scorer: substitute.id,
      reassigned_from: cm.id,
      reassigned_by: director.id,
      reassign_reason: '示例：原评分人的近亲属在该供应商任职',
      reassigned_date: day(0),
      scored: false,
      defaulted: false,
    });
    expect(price.score ?? null).toBeNull();
    expect(price.comment ?? null).toBeNull();
    // 评分截止日不变；替代人员收到「待你评分」，原评分人收到已改派
    expect((await review(id)).score_due).toBe(day(10));
    await expect.poll(async () => (await inbox(substitute.id, id)).some((m) => String(m.title).includes('改派给你'))).toBe(true);
    await expect.poll(async () => (await inbox(cm.id, id)).some((m) => String(m.title).includes('已改派他人'))).toBe(true);

    // 原评分人再也评不了这一项
    const gone = await score(cm, id, 100);
    expect(gone.res).toMatchObject({ status: 'refused', refusalMessage: expect.stringContaining('No score lines of this review are assigned to you') });

    // 替代人员评分；全部评完转审定中，改派人不是评分人，可以审定
    const done = await score(substitute, id, 70);
    expect(done.titles).toHaveLength(1);
    expect((await linesOf(id)).PRICE).toMatchObject({ score: 70, scored: true, scorer: substitute.id, reassigned_from: cm.id });
    for (const who of [buyer, sqe]) await score(who, id, 80);
    expect(await review(id)).toMatchObject({ status: 'reviewing', cost_score: 70 });

    // 只有人工评分中的考评单可以改派
    const late = await reassign(director, String((await linesOf(id)).PLAN_FULFIL!.id));
    expect(late.res).toMatchObject({ status: 'refused', refusalMessage: expect.stringContaining('only while the review is in manual scoring') });
  });

  it('assigns a line that had no scorer at generation', async () => {
    const id = String((await reviewOf(v.unassigned!)).id);
    const lines = await linesOf(id);
    expect(lines.PRICE!.scorer ?? null).toBeNull();
    expect(lines.PRICE!.scored).toBe(false);

    await reassign(director, String(lines.PRICE!.id), { new_scorer: substitute.id, reason_text: '示例：品类尚未设置评分人' });
    const price = (await linesOf(id)).PRICE!;
    expect(price).toMatchObject({ scorer: substitute.id, reassigned_by: director.id, scored: false });
    expect(price.reassigned_from ?? null).toBeNull();
    await expect.poll(async () => (await inbox(substitute.id, id)).length).toBeGreaterThan(0);
  });
});
