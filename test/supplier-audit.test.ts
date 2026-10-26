import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import {
  Category,
  QualityIssue,
  Supplier,
  SupplierApplication,
  SupplierAudit,
  SupplierAuditFinding,
  SupplierCategory,
} from '../src/core/objects';

// v0.4 Q3 供应商审核（02 §4.2，03 §3 第 5 步、§13，FR-204、FR-607，WI-01）：高风险品类的准入以现场审核为前置，
// 有条件通过的准入批准后为试供；结论按分数线校验；审核问题项转整改单；年度审核计划按物资类别生成，跑两遍不重复。
// 测试数据全部在这里生成（示例公司名、示例品类）。
describe('supplier audit', () => {
  let stack: VerifyStack;
  let seq = 0;

  type Person = { token: string; id: string };
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`audit-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const system = async (object: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(object, 'insert', doc, { system: true })) as { id: string };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const insert = async (as: Person, object: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(object, 'insert', doc, { as: as.token })) as { id: string };
  const update = (as: Person, object: string, doc: Record<string, unknown>) => stack.hooks.run(object, 'update', doc, { as: as.token });

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const today = () => day(0);
  const year = new Date().getUTCFullYear();

  const category = async (doc: Record<string, unknown>) => {
    const n = ++seq;
    return (await system(Category.name, { code: `AUD${n}`, name: `示例审核品类 ${n}`, ...doc })).id;
  };
  const supplier = async (doc: Record<string, unknown> = {}) => {
    const n = ++seq;
    return (
      await system(Supplier.name, { name: `示例审核测试有限公司 ${n}`, credit_code: `91000000MA0AUD${String(n).padStart(4, '0')}`, ...doc })
    ).id;
  };
  // 合格的存量供应商，带若干品类资格
  const qualifiedSupplier = async (categories: string[], doc: Record<string, unknown> = {}) => {
    const id = await supplier({ legacy_imported: true, ...doc });
    for (const c of categories) await system(SupplierCategory.name, { supplier: id, category: c, status: 'qualified' });
    return id;
  };
  const completed = { status: 'done', audit_date: today(), checklist_score: 90, lowest_block_score: 80, result: 'pass' };

  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject') => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment: verdict });
    expect(res.status, await res.clone().text()).toBe(200);
  };

  // 从审核详情页按钮启动「转整改单」，停在确认屏后提交；拒绝时返回 end 节点的结果
  const toScar = async (as: Person, recordId: string) => {
    const started = (await stack.actions.run(SupplierAudit.name, 'srm_audit_finding_to_scar', { as: as.token, recordId })) as {
      status?: string;
      runId?: string;
    };
    if (started.status !== 'paused' || !started.runId) return started;
    return stack.flows.resume({ flowName: 'srm_audit_finding_to_scar', runId: started.runId }, {}, { as: as.token });
  };

  // 定时类 flow 默认不挂（objectstack#25442）；这里打开，与部署时打开开关一致
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
  const generate = async () => {
    const run = await stack.flows.run('srm_audit_plan_generate', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  const auditsOf = (supplierId: string) => stack.rows(SupplierAudit.name, { supplier: supplierId });

  let sqe: Person;
  let manager: Person;
  let director: Person;
  let qualityManager: Person;

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    sqe = await person('srm_sqe');
    manager = await person('srm_category_manager');
    director = await person('srm_procurement_director');
    qualityManager = await person('srm_quality_manager');
  });

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  describe('admission', () => {
    const apply = async (categories: string[]) => {
      const vendor = await supplier();
      const app = await insert(manager, SupplierApplication.name, { supplier: vendor, applied_categories: categories, reviewer: manager.id });
      return { vendor, app: app.id };
    };
    const toReview = (app: string) => update(manager, SupplierApplication.name, { id: app, status: 'admission_review' });
    const admissionAudit = (vendor: string, app: string, doc: Record<string, unknown>) =>
      insert(sqe, SupplierAudit.name, { supplier: vendor, application: app, audit_type: 'admission', planned_date: today(), ...doc });

    it('keeps a high-risk application out of the admission review until an audit passes, then grants trial on a conditional pass', async () => {
      const risky = await category({ risk_class: 'high', sqe: sqe.id });
      const { vendor, app } = await apply([risky]);
      expect(await row(SupplierApplication.name, app)).toMatchObject({ status: 'doc_review', risk_class: 'high', audit_passed: false });
      await expect(toReview(app)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // 计划中的审核不写回；完成且有条件通过后写回
      const audit = await admissionAudit(vendor, app, {});
      expect((await row(SupplierApplication.name, app)).audit_passed).toBe(false);
      await insert(sqe, SupplierAuditFinding.name, { audit: audit.id, title: '检验规程未覆盖新品', severity: 'serious' });
      await update(sqe, SupplierAudit.name, { id: audit.id, status: 'done', audit_date: today(), checklist_score: 78, lowest_block_score: 72, result: 'conditional' });
      expect(await row(SupplierApplication.name, app)).toMatchObject({ audit_passed: true, audit_result: 'conditional' });

      await toReview(app);
      await decide(manager, app, 'approve');
      await decide(director, app, 'approve');
      await decide(qualityManager, app, 'approve');
      expect((await row(SupplierApplication.name, app)).status).toBe('approved');
      const [grant] = await stack.rows(SupplierCategory.name, { supplier: vendor });
      expect(grant).toMatchObject({ category: risky, status: 'trial' });
    });

    it('blocks the admission review when the audit fails', async () => {
      const { vendor, app } = await apply([await category({ risk_class: 'high' })]);
      await admissionAudit(vendor, app, { ...completed, checklist_score: 60, lowest_block_score: 50, result: 'fail' });
      expect(await row(SupplierApplication.name, app)).toMatchObject({ audit_passed: false, audit_result: 'fail' });
      await expect(toReview(app)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('does not require an audit for a medium-risk application and grants qualified after a pass', async () => {
      const { vendor, app } = await apply([await category({ risk_class: 'medium' })]);
      await toReview(app);
      await decide(manager, app, 'approve');
      await decide(director, app, 'approve');
      const [grant] = await stack.rows(SupplierCategory.name, { supplier: vendor });
      expect(grant!.status).toBe('qualified');
    });

    it('does not let the category manager tick the audit flag', async () => {
      const { app } = await apply([await category({ risk_class: 'high' })]);
      await update(manager, SupplierApplication.name, { id: app, audit_passed: true }).catch(() => undefined);
      expect((await row(SupplierApplication.name, app)).audit_passed).toBe(false);
    });

    it('refuses an admission audit for another supplier\'s application', async () => {
      const { app } = await apply([await category({})]);
      const other = await supplier();
      await expect(admissionAudit(other, app, {})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(insert(sqe, SupplierAudit.name, { supplier: other, audit_type: 'admission', planned_date: today() })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });
  });

  describe('result thresholds', () => {
    const special = async () =>
      (await insert(sqe, SupplierAudit.name, { supplier: await supplier(), audit_type: 'special', planned_date: today() })).id;
    const finish = (id: string, doc: Record<string, unknown>) => update(sqe, SupplierAudit.name, { id, ...completed, ...doc });

    it('refuses a pass below the score lines or with a serious nonconformity', async () => {
      const low = await special();
      await expect(finish(low, { checklist_score: 84 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(finish(low, { lowest_block_score: 69 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await finish(low, { checklist_score: 84, result: 'conditional' });
      expect((await row(SupplierAudit.name, low)).status).toBe('done');

      const serious = await special();
      await insert(sqe, SupplierAuditFinding.name, { audit: serious, title: '无危险化学品管理制度', severity: 'serious' });
      await expect(finish(serious, {})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await finish(serious, { result: 'conditional' });
    });

    it('allows only a fail with a veto finding or two serious nonconformities', async () => {
      const veto = await special();
      await insert(sqe, SupplierAuditFinding.name, { audit: veto, title: '检验报告造假', severity: 'serious', veto: true });
      await expect(finish(veto, { result: 'conditional' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await finish(veto, { result: 'fail' });

      const two = await special();
      await insert(sqe, SupplierAuditFinding.name, { audit: two, title: '仓储无温湿度记录', severity: 'serious' });
      await insert(sqe, SupplierAuditFinding.name, { audit: two, title: '无首件检验', severity: 'serious' });
      await expect(finish(two, { result: 'conditional' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('needs a reason to cancel and keeps a completed audit completed', async () => {
      const id = await special();
      await expect(update(sqe, SupplierAudit.name, { id, status: 'cancelled' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await update(sqe, SupplierAudit.name, { id, status: 'cancelled', cancel_reason: '供应商停产' });
      await update(sqe, SupplierAudit.name, { id, status: 'planned' });
      await finish(id, {});
      await expect(update(sqe, SupplierAudit.name, { id, status: 'planned' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  // OWD private：别人安排的审核靠共享规则 srm_supplier_audit_edit_* 能接手（问题项随审核），谁都删不了（04 §2.3）
  describe('sharing', () => {
    it('lets another SQE and the quality manager take over an audit and its findings, but nobody deletes them', async () => {
      const audit = await insert(sqe, SupplierAudit.name, { supplier: await supplier(), audit_type: 'special', planned_date: today() });
      const finding = await insert(sqe, SupplierAuditFinding.name, { audit: audit.id, title: '示例问题项', severity: 'observation' });
      const otherSqe = await person('srm_sqe');
      for (const [i, as] of [otherSqe, qualityManager].entries()) {
        await update(as, SupplierAudit.name, { id: audit.id, planned_date: day(i + 1) });
        await update(as, SupplierAuditFinding.name, { id: finding.id, title: `示例问题项（接手 ${i + 1}）` });
      }
      expect(await row(SupplierAudit.name, audit.id)).toMatchObject({ planned_date: day(2) });
      expect(await row(SupplierAuditFinding.name, finding.id)).toMatchObject({ title: '示例问题项（接手 2）' });
      for (const as of [sqe, otherSqe, qualityManager, manager]) {
        await expect(stack.hooks.run(SupplierAudit.name, 'delete', { id: audit.id }, { as: as.token })).rejects.toBeTruthy();
      }
      expect(await stack.rows(SupplierAudit.name, { id: audit.id })).toHaveLength(1);
    });

    it('lets internal readers see audits but not change them', async () => {
      const audit = await insert(sqe, SupplierAudit.name, { supplier: await supplier(), audit_type: 'special', planned_date: today() });
      for (const as of [manager, director]) {
        expect(await stack.rows(SupplierAudit.name, { id: audit.id }, { as: as.token })).toHaveLength(1);
        await expect(update(as, SupplierAudit.name, { id: audit.id, planned_date: day(5) })).rejects.toBeTruthy();
      }
    });
  });

  describe('findings to SCAR', () => {
    it('raises one SCAR per nonconformity, links it back, and never raises twice', async () => {
      const vendor = await supplier();
      const audit = await insert(sqe, SupplierAudit.name, { supplier: vendor, audit_type: 'special', planned_date: today() });
      const serious = await insert(sqe, SupplierAuditFinding.name, {
        audit: audit.id,
        title: '来料未按规程抽样',
        description: '抽查 3 批记录均未按 AQL 抽样',
        severity: 'serious',
        requirement: '15 日内提交整改计划',
      });
      const general = await insert(sqe, SupplierAuditFinding.name, { audit: audit.id, title: '量具校准标签过期', severity: 'general' });
      const observation = await insert(sqe, SupplierAuditFinding.name, { audit: audit.id, title: '现场标识可改进', severity: 'observation' });

      // 审核完成前不能转
      expect(await toScar(sqe, audit.id)).toMatchObject({ status: 'refused' });
      await update(sqe, SupplierAudit.name, { id: audit.id, ...completed, checklist_score: 80, result: 'conditional' });
      // 不是质量岗位不能转
      const refused = await toScar(manager, audit.id);
      expect(refused, JSON.stringify(refused)).toMatchObject({ status: 'refused' });

      const run = await toScar(sqe, audit.id);
      expect(run, JSON.stringify(run)).toMatchObject({ success: true });
      const issues = await stack.rows(QualityIssue.name, { audit: audit.id });
      expect(issues).toHaveLength(2);
      const bySeverity = Object.fromEntries(issues.map((i) => [i.severity, i]));
      expect(bySeverity.critical).toMatchObject({ supplier: vendor, source: 'audit', status: 'open', sqe: sqe.id });
      expect(String(bySeverity.critical!.problem_description)).toContain('来料未按规程抽样');
      expect(String(bySeverity.critical!.problem_description)).toContain('AQL');
      expect(String(bySeverity.critical!.problem_description)).toContain('15 日内提交整改计划');
      expect(bySeverity.major).toBeTruthy();

      expect((await row(SupplierAuditFinding.name, serious.id)).quality_issue).toBe(bySeverity.critical!.id);
      expect((await row(SupplierAuditFinding.name, general.id)).quality_issue).toBe(bySeverity.major!.id);
      expect((await row(SupplierAuditFinding.name, observation.id)).quality_issue ?? null).toBeNull();

      // 再点一次：没有待转的问题项
      expect(await toScar(qualityManager, audit.id)).toMatchObject({ status: 'refused' });
      expect(await stack.rows(QualityIssue.name, { audit: audit.id })).toHaveLength(2);
      // 转出的问题项不再修改
      await update(sqe, SupplierAuditFinding.name, { id: serious.id, title: '改过的标题' }).catch(() => undefined);
      expect((await row(SupplierAuditFinding.name, serious.id)).title).toBe('来料未按规程抽样');
    });
  });

  describe('annual plan', () => {
    let classA: string;
    let classB: string;
    let classC: string;

    beforeAll(async () => {
      classA = await category({ material_class: 'class_a', sqe: sqe.id });
      classB = await category({ material_class: 'class_b' });
      classC = await category({ material_class: 'class_c' });
    });

    const pastAudit = (vendor: string, auditDate: string) =>
      system(SupplierAudit.name, { supplier: vendor, audit_type: 'annual', ...completed, audit_date: auditDate });

    it('plans class A and B suppliers by their frequency, and a second run creates nothing new', async () => {
      // A 类，从没审核过：今天到期
      const neverAudited = await qualifiedSupplier([classA]);
      // A 类，上次审核在去年 12 月 31 日：今年 12 月 31 日到期
      const dueAtYearEnd = await qualifiedSupplier([classA]);
      await pastAudit(dueAtYearEnd, `${year - 1}-12-31`);
      // A 类，今年 1 月 1 日审核过：明年才到期
      const auditedThisYear = await qualifiedSupplier([classA]);
      await pastAudit(auditedThisYear, `${year}-01-01`);
      // B 类，两年前 1 月 1 日审核过：今年 1 月 1 日已到期，计划日期取今天
      const classBDue = await qualifiedSupplier([classB]);
      await pastAudit(classBDue, `${year - 2}-01-01`);
      // B 类，去年 1 月 1 日审核过：24 个月后才到期
      const classBNotDue = await qualifiedSupplier([classB]);
      await pastAudit(classBNotDue, `${year - 1}-01-01`);
      // 同时供 A、B 两类，去年 1 月 1 日审核过：按 A 类 12 个月，今年到期
      const both = await qualifiedSupplier([classB, classA]);
      await pastAudit(both, `${year - 1}-01-01`);
      // C 类不定期；冻结的供应商不排计划
      const classCOnly = await qualifiedSupplier([classC]);
      const frozen = await qualifiedSupplier([classA]);
      await stack.hooks.run(Supplier.name, 'update', { id: frozen, status: 'frozen' }, { system: true });

      await generate();
      const planned = async (id: string) => (await auditsOf(id)).filter((a) => a.status === 'planned');

      const [first] = await planned(neverAudited);
      expect(first).toMatchObject({ audit_type: 'annual', plan_year: year, planned_date: today(), auditors: [sqe.id] });
      expect(String(first!.audit_no)).toMatch(/^AUD\d{4}\d{5}$/);
      expect((await planned(dueAtYearEnd))[0]).toMatchObject({ planned_date: `${year}-12-31` });
      expect(await planned(auditedThisYear)).toHaveLength(0);
      expect((await planned(classBDue))[0]).toMatchObject({ planned_date: today(), plan_year: year });
      expect(await planned(classBNotDue)).toHaveLength(0);
      expect((await planned(both))[0]).toMatchObject({ planned_date: today() });
      expect(await planned(both)).toHaveLength(1);
      expect(await planned(classCOnly)).toHaveLength(0);
      expect(await planned(frozen)).toHaveLength(0);

      // 跑第二遍：不重复建
      const count = async () =>
        (await Promise.all([neverAudited, dueAtYearEnd, classBDue, both].map(auditsOf))).reduce((n, list) => n + list.length, 0);
      const before = await count();
      await generate();
      expect(await count()).toBe(before);
    });

    it('does not plan again after the quality department cancels this year\'s audit', async () => {
      const vendor = await qualifiedSupplier([classB]);
      await generate();
      const [plan] = await auditsOf(vendor);
      expect(plan).toMatchObject({ status: 'planned', plan_year: year });
      await update(qualityManager, SupplierAudit.name, { id: plan!.id, status: 'cancelled', cancel_reason: 'B 类非危化供应商，本年不安排现场复审（WI-01 6.9）' });
      await generate();
      expect(await auditsOf(vendor)).toHaveLength(1);
    });
  });
});
