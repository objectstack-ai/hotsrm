import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, DeliveryRecord, Material, QualityIssue, Supplier } from '../src/core/objects';

// v0.4 Q2 整改单 SCAR / 8D（02 §4.6、§5.6，03 §8，FR-602–606，BR-15）：主要 / 严重不合格交付自动开单 → SQE 代录 D3、
// D4–D7 → SQE 审核退回一次 → 通过 → 效果验证 → 关闭（07 §2.1 第 5 步）；复发重开；逾期扫描置标志并通知；
// 索赔「已扣款」只由应付会计标记。测试数据全部在这里生成（示例公司名、示例物料），不依赖外部样本。
describe('quality issue (SCAR / 8D)', () => {
  let stack: VerifyStack;
  let seq = 0;

  type Person = { token: string; id: string };
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`scar-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const system = async (object: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(object, 'insert', doc, { system: true })) as { id: string };
  const issue = async (id: string) => (await stack.rows(QualityIssue.name, { id }))[0]!;
  const issuesOf = (deliveryId: string) => stack.rows(QualityIssue.name, { delivery_record: deliveryId });
  const update = (as: Person, id: string, doc: Record<string, unknown>) =>
    stack.hooks.run(QualityIssue.name, 'update', { id, ...doc }, { as: as.token });
  // 站内信经消息服务异步投递：等到收齐 count 条（或超时）再读
  const inbox = async (userId: string, recordId: string, title = '', count = 1) => {
    const read = async () =>
      (await stack.rows('sys_inbox_message', { user_id: userId })).filter(
        (m) => String(m.action_url).endsWith(`/${recordId}`) && String(m.title).includes(title),
      );
    for (let i = 0; i < 40 && (await read()).length < count; i++) await new Promise((r) => setTimeout(r, 50));
    return read();
  };

  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject', comment = '') => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment });
    expect(res.status, await res.clone().text()).toBe(200);
    return req!;
  };

  let sqe: Person;
  let qualityManager: Person;
  let buyer: Person;
  let accountant: Person;
  let supplierId: string;
  let materialId: string;
  let orphanMaterialId: string;

  // 交付记录：SQE 录入（月度导入走同一条写入路径）
  const delivery = async (doc: Record<string, unknown>, as = sqe) =>
    (await stack.hooks.run(
      DeliveryRecord.name,
      'insert',
      {
        erp_receipt_no: `50${String(++seq).padStart(8, '0')}`,
        erp_order_no: '4500020001',
        erp_line_no: '10',
        supplier: supplierId,
        material: materialId,
        required_date: '2026-10-10',
        receipt_date: '2026-10-12',
        received_quantity: 1000,
        ...doc,
      },
      { as: as.token },
    )) as { id: string };
  const majorFail = { inspection_result: 'fail', severity: 'major', defect_quantity: 30, defect_description: '尺寸超差' };
  // 一张自动开出的整改单
  const autoIssue = async () => {
    const record = await delivery(majorFail);
    const [created] = await issuesOf(record.id);
    expect(created, 'no SCAR opened').toBeTruthy();
    return String(created!.id);
  };

  // 定时类 flow 默认不挂（objectstack#25442）；这里打开，与部署时打开开关一致
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  const sweep = async () => {
    const run = await stack.flows.run('srm_scar_overdue_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    sqe = await person('srm_sqe');
    qualityManager = await person('srm_quality_manager');
    buyer = await person('srm_buyer');
    accountant = await person('srm_ap_accountant');
    const category = await system(Category.name, { code: `SCAR-${++seq}`, name: '示例品类（整改）', sqe: sqe.id, material_class: 'class_a' });
    const bare = await system(Category.name, { code: `SCAR-${++seq}`, name: '示例品类（无 SQE）' });
    materialId = (await system(Material.name, { erp_material_no: `EX-SCAR-${++seq}`, material_code: `M-SCAR-${seq}`, name: '示例冲压件', category: category.id })).id;
    orphanMaterialId = (await system(Material.name, { erp_material_no: `EX-SCAR-${++seq}`, material_code: `M-SCAR-${seq}`, name: '示例紧固件', category: bare.id })).id;
    supplierId = (
      await system(Supplier.name, { name: '示例整改测试有限公司', credit_code: '91000000MA0SCAR001', legacy_imported: true })
    ).id;
  });

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('opens a SCAR for a major nonconforming delivery and assigns the category SQE', async () => {
    const before = Date.now();
    const record = await delivery(majorFail);
    const issues = await issuesOf(record.id);
    expect(issues).toHaveLength(1);
    const created = issues[0]!;
    expect(created).toMatchObject({
      supplier: supplierId,
      material: materialId,
      source: 'iqc',
      severity: 'major',
      status: 'open',
      sqe: sqe.id,
      is_overdue: false,
      claim_status: 'none',
    });
    expect(String(created.issue_no)).toMatch(/^SCAR\d{4}\d{5}$/);
    expect(String(created.problem_description)).toContain('不良数 30');
    expect(String(created.problem_description)).toContain('尺寸超差');
    // 临时措施 72 小时、最终回复 30 天（params/core.yaml 示例值）
    const containment = new Date(String(created.containment_due)).getTime();
    expect(containment - before).toBeGreaterThan(71 * 3_600_000);
    expect(containment - before).toBeLessThan(73 * 3_600_000);
    const finalDays = (new Date(String(created.final_due)).getTime() - new Date(new Date().toISOString().slice(0, 10)).getTime()) / 86_400_000;
    expect(finalDays).toBe(30);
    expect(await inbox(sqe.id, String(created.id), '新整改单')).toHaveLength(1);
  });

  it('opens one for a critical failure, none for a minor one, and never two for the same delivery', async () => {
    const critical = await delivery({ ...majorFail, severity: 'critical' });
    expect(await issuesOf(critical.id)).toHaveLength(1);

    const minor = await delivery({ ...majorFail, severity: 'minor' });
    expect(await issuesOf(minor.id)).toHaveLength(0);
    // 第二遍导入把次要改成主要：变成主要不合格时开单
    await stack.hooks.run(DeliveryRecord.name, 'update', { id: minor.id, severity: 'major' }, { as: sqe.token });
    expect(await issuesOf(minor.id)).toHaveLength(1);
    // 再改回严重、改其他字段：已有整改单，不再开
    await stack.hooks.run(DeliveryRecord.name, 'update', { id: minor.id, severity: 'critical' }, { as: sqe.token });
    await stack.hooks.run(DeliveryRecord.name, 'update', { id: minor.id, defect_quantity: 40 }, { as: sqe.token });
    expect(await issuesOf(minor.id)).toHaveLength(1);

    const passed = await delivery({ inspection_result: 'pass' });
    expect(await issuesOf(passed.id)).toHaveLength(0);
  });

  it('notifies the quality managers when the category has no SQE', async () => {
    const record = await delivery({ ...majorFail, material: orphanMaterialId });
    const [created] = await issuesOf(record.id);
    expect(created!.sqe ?? null).toBeNull();
    expect(await inbox(qualityManager.id, String(created!.id), '新整改单')).toHaveLength(1);
  });

  it('runs the 8D loop: D3, D4–D7, one return with a comment, approval, verification and closure', async () => {
    const id = await autoIssue();
    // 填好 D3 才能提交临时措施
    await expect(update(sqe, id, { status: 'containment_submitted' })).rejects.toBeTruthy();
    await update(sqe, id, { containment_action: '库存 30 件隔离，100% 全检后放行', status: 'containment_submitted' });
    // 填好 D4–D7 才能提交根因与措施
    await expect(update(sqe, id, { status: 'action_submitted' })).rejects.toBeTruthy();
    await update(sqe, id, { root_cause: '模具磨损未按期更换', corrective_action: '更换模具镶块', preventive_action: '模具寿命纳入点检表', status: 'action_submitted' });
    expect((await issue(id)).status).toBe('action_submitted');
    // 审核中锁定记录
    await expect(update(sqe, id, { root_cause: '审核中改根因' })).rejects.toBeTruthy();

    // 退回没写意见：这次退回不算，重新审核
    const first = await decide(sqe, id, 'reject');
    expect((await issue(id)).status).toBe('action_submitted');
    const again = await pending(id);
    expect(again, 'review should reopen').toBeTruthy();
    expect(again!.id).not.toBe(first.id);

    await decide(sqe, id, 'reject', '根因只写了模具磨损，请补充点检为什么没发现');
    expect(await issue(id)).toMatchObject({ status: 'containment_submitted', sqe_comment: '根因只写了模具磨损，请补充点检为什么没发现' });
    expect(await inbox(sqe.id, id, '已退回')).toHaveLength(1);

    await update(sqe, id, { root_cause: '模具磨损；点检表没有镶块尺寸项，未及时发现', status: 'action_submitted' });
    await decide(sqe, id, 'approve');
    expect((await issue(id)).status).toBe('verifying');

    await update(sqe, id, { status: 'closed' });
    expect((await issue(id)).status).toBe('closed');
    // 关闭后 8D 内容只读：服务端丢弃对只读字段的写入
    await update(sqe, id, { root_cause: '关闭后改根因' });
    expect((await issue(id)).root_cause).toBe('模具磨损；点检表没有镶块尺寸项，未及时发现');
  });

  it('refuses a manual return without a comment and illegal status jumps', async () => {
    const id = await autoIssue();
    await expect(update(sqe, id, { status: 'verifying' })).rejects.toBeTruthy();
    await update(sqe, id, { containment_action: '隔离库存', status: 'containment_submitted' });
    await expect(update(sqe, id, { status: 'open' })).rejects.toBeTruthy();
    await update(sqe, id, { status: 'open', sqe_comment: '临时措施没有覆盖在途批次' });
    expect((await issue(id)).status).toBe('open');
    await update(sqe, id, { status: 'cancelled' });
    await expect(update(sqe, id, { status: 'open' })).rejects.toBeTruthy();
  });

  it('reopens a closed SCAR when the problem recurs and restarts its deadlines', async () => {
    const id = await autoIssue();
    await update(sqe, id, { containment_action: '隔离', status: 'containment_submitted' });
    await update(sqe, id, { root_cause: '原因', corrective_action: '措施', status: 'action_submitted' });
    await decide(sqe, id, 'approve');
    await update(sqe, id, { status: 'closed' });
    // 关闭前已逾期
    await stack.hooks.run(QualityIssue.name, 'update', { id, is_overdue: true, final_due: '2026-01-01' }, { system: true });

    await update(sqe, id, { status: 'open' });
    const reopened = await issue(id);
    expect(reopened).toMatchObject({ status: 'open', is_overdue: false });
    expect(new Date(String(reopened.containment_due)).getTime()).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    expect(String(reopened.final_due) > new Date().toISOString().slice(0, 10)).toBe(true);
    expect(await inbox(sqe.id, id, '重新打开')).toHaveLength(1);
  });

  it('flags overdue SCARs once and notifies the SQE and the quality manager', async () => {
    const late = await autoIssue();
    const finalLate = await autoIssue();
    const onTime = await autoIssue();
    const verifying = await autoIssue();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    await stack.hooks.run(QualityIssue.name, 'update', { id: late, containment_due: hourAgo }, { system: true });
    // 已提交 D3，但最终回复期限已过
    await update(sqe, finalLate, { containment_action: '隔离', status: 'containment_submitted' });
    await stack.hooks.run(QualityIssue.name, 'update', { id: finalLate, containment_due: hourAgo, final_due: '2026-01-01' }, { system: true });
    // 已进入效果验证的不算逾期
    await update(sqe, verifying, { containment_action: '隔离', status: 'containment_submitted' });
    await update(sqe, verifying, { root_cause: '原因', corrective_action: '措施', status: 'action_submitted' });
    await decide(sqe, verifying, 'approve');
    await stack.hooks.run(QualityIssue.name, 'update', { id: verifying, containment_due: hourAgo, final_due: '2026-01-01' }, { system: true });

    await sweep();
    expect((await issue(late)).is_overdue).toBe(true);
    expect((await issue(finalLate)).is_overdue).toBe(true);
    expect((await issue(onTime)).is_overdue).toBe(false);
    expect((await issue(verifying)).is_overdue).toBe(false);
    expect(await inbox(qualityManager.id, late, '临时措施已逾期')).toHaveLength(1);
    expect(await inbox(sqe.id, finalLate, '最终回复已逾期')).toHaveLength(1);
    expect(await inbox(qualityManager.id, finalLate, '最终回复已逾期')).toHaveLength(1);

    // 追赶式且幂等：再跑一次不重复通知
    await sweep();
    expect(await inbox(qualityManager.id, late, '逾期', 2)).toHaveLength(1);
    // 逾期标志只由扫描维护
    await expect(update(sqe, onTime, { is_overdue: true })).rejects.toBeTruthy();

    // 质量看板的「逾期整改单」「未关闭整改单（按状态）」与记录一致
    const res = await stack.apiAs(qualityManager.token, 'POST', '/analytics/dataset/query', {
      datasetName: 'srm_quality_issue_metrics',
      selection: { dimensions: ['status'], measures: ['open_count', 'overdue_count'] },
    });
    const body = (await res.json()) as { rows: Array<Record<string, number | string>> };
    expect(res.status, JSON.stringify(body)).toBe(200);
    const all = await stack.rows(QualityIssue.name, {});
    const unfinished = all.filter((r) => ['open', 'containment_submitted', 'action_submitted', 'verifying'].includes(String(r.status)));
    const sum = (k: string) => body.rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    expect(sum('open_count')).toBe(unfinished.length);
    expect(sum('overdue_count')).toBe(unfinished.filter((r) => r.is_overdue === true).length);
    expect(sum('overdue_count')).toBeGreaterThanOrEqual(2);
  });

  it('records claims; only the AP accountant marks an accepted claim as settled', async () => {
    const id = await autoIssue();
    await expect(update(sqe, id, { claim_status: 'proposed' })).rejects.toBeTruthy();
    await update(sqe, id, { claim_amount: 12000, claim_status: 'proposed' });
    // 财务只能改索赔状态，且只能从「供应商已接受」标记已扣款
    await expect(update(accountant, id, { claim_status: 'settled' })).rejects.toBeTruthy();
    await update(sqe, id, { claim_status: 'supplier_accepted' });
    await expect(update(sqe, id, { claim_status: 'settled' })).rejects.toBeTruthy();
    await expect(update(accountant, id, { claim_amount: 1 })).rejects.toBeTruthy();
    await update(accountant, id, { claim_status: 'settled' });
    expect(await issue(id)).toMatchObject({ claim_status: 'settled', claim_amount: 12000 });
  });

  it('lets the SQE open one by hand; buyers only read', async () => {
    const manual = (await stack.hooks.run(
      QualityIssue.name,
      'insert',
      { supplier: supplierId, source: 'customer', severity: 'major', problem_description: '客户投诉：示例冲压件毛刺划伤', sqe: sqe.id },
      { as: sqe.token },
    )) as { id: string };
    expect(await issue(manual.id)).toMatchObject({ status: 'open', source: 'customer', is_overdue: false });
    // 不能一建就是已关闭
    await expect(
      stack.hooks.run(QualityIssue.name, 'insert', { supplier: supplierId, severity: 'minor', problem_description: '直接关闭', status: 'closed' }, { as: sqe.token }),
    ).rejects.toBeTruthy();

    expect((await stack.rows(QualityIssue.name, { id: manual.id }, { as: buyer.token })).length).toBe(1);
    await expect(
      stack.hooks.run(QualityIssue.name, 'insert', { supplier: supplierId, severity: 'minor', problem_description: '采购员开单' }, { as: buyer.token }),
    ).rejects.toBeTruthy();
    await expect(update(buyer, manual.id, { sqe_comment: '采购员改' })).rejects.toBeTruthy();
    await expect(stack.hooks.run(QualityIssue.name, 'delete', { id: manual.id }, { as: sqe.token })).rejects.toBeTruthy();
  });
});
