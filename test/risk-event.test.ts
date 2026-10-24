import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, RiskEvent, Supplier, SupplierCategory, SupplierCertificate, SupplierDisposition } from '../src/core/objects';

// v0.5 R1 风险事件与黑名单名录（02 §4.9，03 §5、§11，FR-208、FR-902、FR-903）：手工登记、必备证书过期生成资质事件
// 与恢复后关闭、高风险事件生成冻结处置单草稿（提交审批 / 作废）、黑名单名录字段与禁入期满提醒。
// 测试数据全部在这里生成（示例公司名、示例品类），不依赖外部样本。
describe('risk events and the blacklist register', () => {
  let stack: VerifyStack;
  let seq = 0;

  type Person = { token: string; id: string };
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const person = async (...positions: string[]): Promise<Person> => {
    const token = await stack.signUp(`rsk-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const system = (object: string, doc: Record<string, unknown>) =>
    stack.hooks.run(object, 'insert', doc, { system: true }) as Promise<{ id: string }>;
  const inbox = async (userId: string, recordId: string) =>
    (await stack.rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));

  // 合格供应商（存量导入建档即为合格），一个合格的品类资格，品类经理为 manager
  const qualifiedSupplier = async () => {
    const n = ++seq;
    const supplier = await system(Supplier.name, {
      name: `示例风险测试有限公司 ${n}`,
      credit_code: `91000000MA0RSK${String(n).padStart(4, '0')}`,
      legacy_imported: true,
    });
    const category = await system(Category.name, { code: `RSK${n}`, name: `示例风险品类 ${n}`, category_manager: manager.id });
    await system(SupplierCategory.name, { supplier: supplier.id, category: category.id, status: 'qualified' });
    return supplier.id;
  };
  const register = (as: Person, doc: Record<string, unknown>) =>
    stack.hooks.run(RiskEvent.name, 'insert', { risk_type: 'legal', description: '示例：供应商涉及合同纠纷诉讼', ...doc }, { as: as.token }) as Promise<{
      id: string;
    }>;
  const events = (filter: Record<string, unknown>) => stack.rows(RiskEvent.name, filter);
  const dispositions = (supplier: string) => stack.rows(SupplierDisposition.name, { supplier });

  const sweep = async () => {
    const run = await stack.flows.run('srm_certificate_expire_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  const certificate = async (supplier: string, validTo: string, isMandatory: boolean) => {
    const name = `rsk-cert-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [
      { key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' },
    ]);
    return (
      await stack.hooks.run(
        SupplierCertificate.name,
        'insert',
        {
          supplier,
          cert_type: 'iso9001',
          cert_no: `示例证书 ${seq}`,
          valid_from: day(-400),
          valid_to: validTo,
          is_mandatory: isMandatory,
          attachment: String(file!.id),
        },
        { as: sqe.token },
      )
    ).id as string;
  };

  // 启动 screen flow；停在确认页时用 input 提交，拒绝时返回 end 节点的结果
  const runScreen = async (as: Person, flow: string, recordId: string, input: Record<string, unknown> = {}) => {
    const started = (await stack.actions.run(SupplierDisposition.name, flow, { as: as.token, recordId })) as { runId?: string; status?: string };
    if (started.status !== 'paused' || !started.runId) return started;
    return stack.flows.resume({ flowName: flow, runId: started.runId }, input, { as: as.token });
  };
  const pending = async (recordId: string) =>
    (await stack.rows('sys_approval_request', { record_id: recordId })).find((r) => r.status === 'pending');
  const decide = async (as: Person, recordId: string, verdict: 'approve' | 'reject') => {
    const req = await pending(recordId);
    expect(req, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(as.token, 'POST', `/approvals/requests/${req!.id}/${verdict}`, { comment: verdict });
    expect(res.status, await res.clone().text()).toBe(200);
  };

  let manager: Person;
  let lead: Person;
  let sqe: Person;
  let buyer: Person;
  let director: Person;
  let gm: Person;
  let compliance: Person;

  // 定时类 flow 默认不挂（objectstack#25442）；这里打开，禁入期满提醒才能由平台的扫描任务触发
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    manager = await person('srm_category_manager');
    lead = await person('srm_buyer_lead');
    sqe = await person('srm_sqe');
    buyer = await person('srm_buyer');
    director = await person('srm_procurement_director');
    gm = await person('srm_general_manager');
    compliance = await person('srm_procurement_compliance');
  });

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('registers a risk event by hand and closes it only with a conclusion', async () => {
    const supplier = await qualifiedSupplier();
    // 来源只由 flow 写：手工登记写了 system 也记为手工
    const event = await register(manager, { supplier, severity: 'medium', source: 'system' });
    expect(await row(RiskEvent.name, event.id)).toMatchObject({ status: 'open', source: 'manual', severity: 'medium' });
    expect(String((await row(RiskEvent.name, event.id)).event_no)).toMatch(/^RSK\d{9}$/);

    await stack.hooks.run(RiskEvent.name, 'update', { id: event.id, status: 'mitigating', mitigation_plan: '示例：要求供应商提交诉讼进展说明' }, { as: sqe.token });
    await expect(stack.hooks.run(RiskEvent.name, 'update', { id: event.id, status: 'closed' }, { as: sqe.token })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await stack.hooks.run(RiskEvent.name, 'update', { id: event.id, status: 'closed', owner_note: '示例：诉讼已和解，不影响供货' }, { as: sqe.token });
    expect((await row(RiskEvent.name, event.id)).status).toBe('closed');
    // 中风险不生成处置单草稿
    expect(await dispositions(supplier)).toHaveLength(0);
  });

  it('does not let a buyer register risk events', async () => {
    const supplier = await qualifiedSupplier();
    await expect(register(buyer, { supplier })).rejects.toBeTruthy();
    expect(await events({ supplier })).toHaveLength(0);
  });

  it('opens a qualification event when a mandatory certificate expires and closes it once restored', async () => {
    const supplier = await qualifiedSupplier();
    const cert = await certificate(supplier, day(-1), true);
    await sweep();
    expect((await row(Supplier.name, supplier)).qualification_alert).toBe(true);
    const opened = await events({ supplier });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ risk_type: 'qualification', source: 'system', severity: 'medium', status: 'open', certificate: cert });
    expect(String(opened[0]!.description)).toContain('ISO 9001');

    // 系统生成的事件由品类经理接手处理
    await stack.hooks.run(RiskEvent.name, 'update', { id: opened[0]!.id, status: 'mitigating', mitigation_plan: '示例：催供应商换证' }, { as: manager.token });
    expect((await row(RiskEvent.name, opened[0]!.id as string)).status).toBe('mitigating');

    // 再扫一次、改证书的其他字段都不重复建
    await sweep();
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: cert, issuer: '示例认证机构' }, { as: sqe.token });
    expect(await events({ supplier })).toHaveLength(1);

    // 延期后次日扫描：资质异常解除，事件自动关闭并写处理结论
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: cert, valid_to: day(365) }, { as: sqe.token });
    await sweep();
    expect((await row(Supplier.name, supplier)).qualification_alert).toBe(false);
    const closed = await row(RiskEvent.name, opened[0]!.id as string);
    expect(closed.status).toBe('closed');
    expect(String(closed.owner_note)).toContain('自动关闭');
  });

  it('opens no event for an optional certificate and keeps hand-registered events open on recovery', async () => {
    const supplier = await qualifiedSupplier();
    await certificate(supplier, day(-1), false);
    await sweep();
    expect(await events({ supplier })).toHaveLength(0);

    const manual = await register(sqe, { supplier, risk_type: 'qualification', description: '示例：供应商生产许可证正在换证' });
    const cert = await certificate(supplier, day(-1), true);
    await sweep();
    await stack.hooks.run(SupplierCertificate.name, 'update', { id: cert, valid_to: day(365) }, { as: sqe.token });
    await sweep();
    expect((await row(RiskEvent.name, manual.id)).status).toBe('open');
  });

  it('drafts a freeze disposition for a high-severity event, and the category manager submits it', async () => {
    const supplier = await qualifiedSupplier();
    const event = await register(manager, { supplier, severity: 'high', risk_type: 'sanction', description: '示例：供应商列入制裁名单' });
    const [draft] = await dispositions(supplier);
    expect(draft).toMatchObject({ status: 'draft', action: 'freeze', scope: 'all' });
    expect(String(draft!.reason)).toContain('示例：供应商列入制裁名单');
    expect((await row(RiskEvent.name, event.id)).disposition).toBe(draft!.id);
    // 草稿不进审批，供应商不变；通知品类经理
    expect(await pending(draft!.id as string)).toBeUndefined();
    expect((await row(Supplier.name, supplier)).status).toBe('qualified');
    await expect.poll(async () => (await inbox(manager.id, event.id)).length).toBe(1);

    // 第二个高风险事件并到同一张草稿
    const second = await register(sqe, { supplier, severity: 'high', risk_type: 'operation', description: '示例：经营异常名录' });
    expect(await dispositions(supplier)).toHaveLength(1);
    expect((await row(RiskEvent.name, second.id)).disposition).toBe(draft!.id);

    // 采购员不能提交；品类经理提交后以他为发起人审批，通过后冻结
    expect(await runScreen(buyer, 'srm_disposition_submit', draft!.id as string)).toMatchObject({ status: 'refused' });
    await runScreen(manager, 'srm_disposition_submit', draft!.id as string);
    expect(await row(SupplierDisposition.name, draft!.id as string)).toMatchObject({ status: 'in_review', submitted_by: manager.id });
    await decide(director, draft!.id as string, 'approve');
    expect(await row(SupplierDisposition.name, draft!.id as string)).toMatchObject({ status: 'applied', director_approver: director.id });
    expect((await row(Supplier.name, supplier)).status).toBe('frozen');
  });

  it('routes a draft submitted by a buyer lead through the category manager level first', async () => {
    const supplier = await qualifiedSupplier();
    await register(sqe, { supplier, severity: 'high', description: '示例：重大质量事故' });
    const [draft] = await dispositions(supplier);
    await runScreen(lead, 'srm_disposition_submit', draft!.id as string);
    await decide(manager, draft!.id as string, 'approve');
    expect(await row(SupplierDisposition.name, draft!.id as string)).toMatchObject({ status: 'in_review', category_approver: manager.id });
    await decide(director, draft!.id as string, 'approve');
    expect((await row(Supplier.name, supplier)).status).toBe('frozen');
  });

  it('lets the category manager cancel a draft, and drafts again when an event is raised to high', async () => {
    const supplier = await qualifiedSupplier();
    const event = await register(manager, { supplier, severity: 'high' });
    const [draft] = await dispositions(supplier);
    await runScreen(manager, 'srm_disposition_cancel', draft!.id as string, { cancel_reason: '示例：核实后风险不成立' });
    expect(await row(SupplierDisposition.name, draft!.id as string)).toMatchObject({ status: 'cancelled', reject_reason: '示例：核实后风险不成立' });
    expect((await row(Supplier.name, supplier)).status).toBe('qualified');
    // 作废的草稿不能再提交
    expect(await runScreen(manager, 'srm_disposition_submit', draft!.id as string)).toMatchObject({ status: 'refused' });

    // 中风险改为高风险时生成草稿；已回填处置单的事件不再生成
    const medium = await register(manager, { supplier, severity: 'medium' });
    expect((await dispositions(supplier)).filter((d) => d.status === 'draft')).toHaveLength(0);
    await stack.hooks.run(RiskEvent.name, 'update', { id: medium.id, severity: 'high' }, { as: manager.token });
    expect((await dispositions(supplier)).filter((d) => d.status === 'draft')).toHaveLength(1);
    expect((await row(RiskEvent.name, event.id)).disposition).toBe(draft!.id);
  });

  it('only notifies for a high-severity event on a supplier that cannot be frozen', async () => {
    const supplier = await qualifiedSupplier();
    await stack.hooks.run(Supplier.name, 'update', { id: supplier, status: 'frozen' }, { system: true });
    const event = await register(manager, { supplier, severity: 'high' });
    expect(await dispositions(supplier)).toHaveLength(0);
    expect((await row(RiskEvent.name, event.id)).disposition ?? null).toBeNull();
    await expect.poll(async () => (await inbox(manager.id, event.id)).length).toBe(1);
  });

  it('refuses to submit a draft once the supplier can no longer be frozen', async () => {
    const supplier = await qualifiedSupplier();
    await register(manager, { supplier, severity: 'high' });
    const [draft] = await dispositions(supplier);
    // 草稿期间另一张处置单已审批中
    const eliminate = (await stack.hooks.run(
      SupplierDisposition.name,
      'insert',
      { supplier, action: 'eliminate', reason: '示例：连续两期 D 级' },
      { as: manager.token },
    )) as { id: string };
    await expect(runScreen(manager, 'srm_disposition_submit', draft!.id as string)).rejects.toBeTruthy();
    expect((await row(SupplierDisposition.name, draft!.id as string)).status).toBe('draft');
    expect((await row(SupplierDisposition.name, eliminate.id)).status).toBe('in_review');
  });

  it('records the blacklist register and reminds before the ban ends', async () => {
    const supplier = await qualifiedSupplier();
    const blacklist = (await stack.hooks.run(
      SupplierDisposition.name,
      'insert',
      { supplier, action: 'blacklist', reason: '示例：提供虚假资质文件' },
      { as: manager.token },
    )) as { id: string };
    await decide(director, blacklist.id, 'approve');
    await decide(gm, blacklist.id, 'approve');
    await decide(compliance, blacklist.id, 'approve');
    const listed = await row(Supplier.name, supplier);
    expect(listed).toMatchObject({
      status: 'blacklisted',
      blacklisted_on: day(0),
      blacklist_disposition: blacklist.id,
      blacklist_reason: '示例：提供虚假资质文件',
    });
    expect(String(listed.blacklist_until)).toBe(`${Number(day(0).slice(0, 4)) + 5}${day(0).slice(4)}`);

    // 禁入期满前 30 天提醒发起人和品类经理（只提醒，不自动解除）
    await stack.hooks.run(Supplier.name, 'update', { id: supplier, blacklist_until: day(30) }, { system: true });
    const job = stack.kernel.getService<{ trigger(name: string): Promise<unknown> }>('job');
    await job.trigger('flow-time-relative:srm_blacklist_expiry_notice');
    await expect.poll(async () => (await inbox(manager.id, supplier)).length).toBeGreaterThan(0);
    expect((await row(Supplier.name, supplier)).status).toBe('blacklisted');
  });
});
