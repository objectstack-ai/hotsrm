import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, Contract, ContractLine, Supplier } from '../src/core/objects';

// v0.3 C1 合同（02 §4.4、§5.5，03 §6）：起草带明细 → 提交审批 → 签署中上传签署件 → 确认生效 →
// 到期提醒 → 到期扫描置为已到期（自动续签的生成续签草稿）；只能与合格供应商签新合同；
// 质量协议 / 廉洁协议生效后供应商标志为 true。主流程走一遍真实审批（C2，分档与职责分离见 contract-approval.test.ts），
// 其余用例以系统身份把状态推进到「签署中」。
// 测试数据全部在这里生成（示例公司名、示例品类），不依赖外部样本。
describe('contract', () => {
  let stack: VerifyStack;
  let seq = 0;

  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const person = async (...positions: string[]) => {
    const token = await stack.signUp(`ct-${positions.join('-')}-${++seq}@example.com`);
    const context = await stack.contextFor(token);
    const org = context.tenantId ? { organization_id: String(context.tenantId) } : {};
    await stack.seed('sys_user_position', positions.map((position) => ({ user_id: String(context.userId), position, ...org })));
    return { token, id: String(context.userId) };
  };
  const row = async (object: string, id: string) => (await stack.rows(object, { id }))[0]!;
  const contract = (id: string) => row(Contract.name, id);

  // 合格供应商：存量导入建档即为合格；需要其他状态时以系统身份按状态机推进
  const supplier = async (status: 'qualified' | 'frozen' | 'eliminated' | 'potential' = 'qualified') => {
    const n = ++seq;
    const legacy = status !== 'potential';
    const created = (await stack.hooks.run(
      Supplier.name,
      'insert',
      { name: `示例合同测试有限公司 ${n}`, credit_code: `91000000MA0CON${String(n).padStart(4, '0')}`, legacy_imported: legacy },
      { system: true },
    )) as { id: string };
    if (status === 'frozen' || status === 'eliminated') {
      await stack.hooks.run(Supplier.name, 'update', { id: created.id, status }, { system: true });
    }
    return created.id;
  };

  const draft = async (as: string, doc: Record<string, unknown>) =>
    (await stack.hooks.run(
      Contract.name,
      'insert',
      { title: `示例框架协议 ${++seq}`, contract_type: 'framework', start_date: day(-30), end_date: day(335), amount: 500000, ...doc },
      { as },
    )) as { id: string };
  const line = (as: string, contractId: string, doc: Record<string, unknown>) =>
    stack.hooks.run(ContractLine.name, 'insert', { contract: contractId, ...doc }, { as });

  // 启动 screen flow 并在确认页提交；拒绝时返回 end 节点的结果
  const runScreen = async (flow: string, as: string, recordId: string) => {
    const started = (await stack.actions.run(Contract.name, flow, { as, recordId })) as { runId?: string; status?: string };
    if (started.status !== 'paused' || !started.runId) return started;
    return stack.flows.resume({ flowName: flow, runId: started.runId }, {}, { as });
  };
  const toSigning = (id: string) => stack.hooks.run(Contract.name, 'update', { id, status: 'signing' }, { system: true });
  const signedFile = async () => {
    const name = `signed-${++seq}.pdf`;
    const [file] = await stack.seed('sys_file', [
      { key: `attachments/${name}`, name, mime_type: 'application/pdf', size: 1, scope: 'attachments', status: 'committed' },
    ]);
    return String(file!.id);
  };
  // 系统身份把一份合同推进到生效（跳过界面），用于到期与续签的用例
  const activeContract = async (doc: Record<string, unknown>) => {
    const created = await draft(manager.token, doc);
    await stack.hooks.run(Contract.name, 'update', { id: created.id, status: 'in_review' }, { system: true });
    await toSigning(created.id);
    await stack.hooks.run(Contract.name, 'update', { id: created.id, signed_file: await signedFile(), signed_date: day(-30) }, { system: true });
    await stack.hooks.run(Contract.name, 'update', { id: created.id, status: 'active' }, { system: true });
    return created.id;
  };
  const sweep = async () => {
    const run = await stack.flows.run('srm_contract_expire_sweep', {}, { system: true });
    expect(run.success, JSON.stringify(run)).toBe(true);
  };
  // 站内信：每位收件人一条，action_url 指向来源记录
  const inbox = async (userId: string, recordId: string) =>
    (await stack.rows('sys_inbox_message', { user_id: userId })).filter((m) => String(m.action_url).endsWith(`/${recordId}`));

  // 样例表格：表头用字段的中文标签，与导入向导按标签对列一致（data/samples/README.md）
  const importSample = async (as: string, object: { name: string; fields: Record<string, { label?: unknown }> }, file: string, matchFields: string[], skipBlankMatchKey = false) => {
    const res = await stack.apiAs(as, 'POST', `/data/${object.name}/import`, {
      format: 'csv',
      csv: readFileSync(new URL(`../data/samples/${file}`, import.meta.url), 'utf8'),
      mapping: Object.fromEntries(Object.entries(object.fields).map(([name, field]) => [String(field.label), name])),
      writeMode: 'upsert',
      matchFields,
      skipBlankMatchKey,
    });
    const body = (await res.json()) as { data?: { ok: number; errors: number; results: unknown[] }; ok?: number; errors?: number };
    expect(res.status, JSON.stringify(body)).toBe(200);
    const result = body.data ?? (body as { ok: number; errors: number; results: unknown[] });
    expect(result.errors, JSON.stringify(result.results)).toBe(0);
    return result;
  };

  let manager: { token: string; id: string };
  let otherManager: { token: string; id: string };
  let buyer: { token: string; id: string };
  let category: string;

  // 定时类 flow 默认不挂（objectstack#25442）；这里打开，到期提醒才能由平台的扫描任务触发
  const scheduledWork = process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;

  beforeAll(async () => {
    process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = 'true';
    stack = await bootStack(config);
    manager = await person('srm_category_manager');
    otherManager = await person('srm_category_manager');
    buyer = await person('srm_buyer');
    category = String(
      ((await stack.hooks.run(
        Category.name,
        'insert',
        { code: `CT-CAT-${++seq}`, name: '示例品类（合同）', category_manager: otherManager.id },
        { system: true },
      )) as { id: string }).id,
    );
  });

  afterAll(async () => {
    await stack?.stop();
    if (scheduledWork === undefined) delete process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED;
    else process.env.OS_AUTOMATION_SCHEDULED_WORK_ENABLED = scheduledWork;
  });

  it('imports the sample contracts and lines as drafts', async () => {
    const admin = await person('srm_admin');
    await importSample(admin.token, Supplier, 'srm_supplier.csv', ['credit_code'], true);
    await importSample(admin.token, Supplier, 'srm_supplier.csv', ['country', 'registration_no'], true);
    expect((await importSample(manager.token, Contract, 'srm_contract.csv', ['title'])).ok).toBe(5);
    expect((await importSample(manager.token, ContractLine, 'srm_contract_line.csv', ['contract', 'line_no'])).ok).toBe(5);
    // 再导一遍不新增
    await importSample(manager.token, Contract, 'srm_contract.csv', ['title']);
    await importSample(manager.token, ContractLine, 'srm_contract_line.csv', ['contract', 'line_no']);
    const [framework] = await stack.rows(Contract.name, { title: '示例五金 2027 年度框架协议' });
    expect(framework).toMatchObject({ status: 'draft', contract_type: 'framework', auto_renew: true });
    expect(Number(framework!.line_amount)).toBe(70000 + 10000 + 210000);
    expect(await stack.rows(ContractLine.name, { contract: String(framework!.id) })).toHaveLength(3);
    const [line] = await stack.rows(ContractLine.name, { contract: String(framework!.id), line_no: 1 });
    expect(Number(line!.tax_rate)).toBeCloseTo(0.13);
  });

  it('lets legal counsel edit a draft but not create one', async () => {
    const legal = await person('srm_legal_counsel');
    const created = await draft(manager.token, { supplier: await supplier() });
    await stack.hooks.run(Contract.name, 'update', { id: created.id, title: '示例框架协议（法务修订）' }, { as: legal.token });
    expect((await contract(created.id)).title).toBe('示例框架协议（法务修订）');
    await expect(draft(legal.token, { supplier: await supplier() })).rejects.toThrow();
  });

  it('drafts a framework agreement with lines, signs it and makes it active', async () => {
    const legal = await person('srm_legal_counsel');
    const director = await person('srm_procurement_director');
    const created = await draft(manager.token, { supplier: await supplier(), category, legal_reviewer: legal.id });
    await line(manager.token, created.id, { line_no: 1, description: '示例紧固件 M8', quantity: 1000, uom: '件', unit_price: 1.5, tax_rate: 0.13 });
    await line(manager.token, created.id, { line_no: 2, description: '示例紧固件 M10', quantity: 200, uom: '件', unit_price: 2.25 });
    const lines = await stack.rows(ContractLine.name, { contract: created.id });
    expect(lines.map((l) => Number(l.amount)).sort((a, b) => a - b)).toEqual([450, 1500]);
    const fresh = await contract(created.id);
    expect(fresh).toMatchObject({ status: 'draft' });
    expect(String(fresh.contract_no)).toMatch(/^CT\d{4}\d{5}$/);
    expect(Number(fresh.line_amount)).toBe(1950);

    const submitted = await runScreen('srm_contract_submit', manager.token, created.id);
    expect((submitted as { success?: boolean }).success, JSON.stringify(submitted)).not.toBe(false);
    expect((await contract(created.id)).status).toBe('in_review');

    // 50 万、品类经理起草：法务 → 采购总监（C2）通过后进入签署中
    for (const approver of [legal, director]) {
      const [req] = (await stack.rows('sys_approval_request', { record_id: created.id })).filter((r) => r.status === 'pending');
      const res = await stack.apiAs(approver.token, 'POST', `/approvals/requests/${req!.id}/approve`, {});
      expect(res.status, await res.clone().text()).toBe(200);
    }
    expect((await contract(created.id)).status).toBe('signing');
    await stack.hooks.run(Contract.name, 'update', { id: created.id, signed_file: await signedFile(), signed_date: day(0) }, { as: buyer.token });
    await runScreen('srm_contract_activate', buyer.token, created.id);
    expect(await contract(created.id)).toMatchObject({ status: 'active', signed_date: day(0) });
  });

  it('refuses to make a contract active without the signed copy', async () => {
    const created = await draft(manager.token, { supplier: await supplier() });
    await stack.hooks.run(Contract.name, 'update', { id: created.id, status: 'in_review' }, { system: true });
    await toSigning(created.id);
    const run = await runScreen('srm_contract_activate', buyer.token, created.id);
    expect(JSON.stringify(run)).toContain('Upload the signed copy');
    expect((await contract(created.id)).status).toBe('signing');
    // 绕过 flow 直接改状态也被校验规则拦住
    await expect(stack.hooks.run(Contract.name, 'update', { id: created.id, status: 'active' }, { system: true })).rejects.toThrow();
  });

  it('only lets category managers submit, and only drafts', async () => {
    const created = await draft(manager.token, { supplier: await supplier() });
    const byBuyer = await runScreen('srm_contract_submit', buyer.token, created.id);
    expect(JSON.stringify(byBuyer)).toContain('Only category managers or buyer leads');
    expect((await contract(created.id)).status).toBe('draft');
  });

  it.each(['frozen', 'eliminated', 'potential'] as const)('refuses a new contract with a %s supplier', async (status) => {
    const target = await supplier(status);
    await expect(draft(manager.token, { supplier: target })).rejects.toThrow(/qualified/);
  });

  it('locks the contract body and lines once it leaves draft', async () => {
    const created = await draft(manager.token, { supplier: await supplier() });
    await line(manager.token, created.id, { line_no: 1, description: '示例服务', quantity: 1, unit_price: 100 });
    await stack.hooks.run(Contract.name, 'update', { id: created.id, status: 'in_review' }, { system: true });
    await expect(line(manager.token, created.id, { line_no: 2, description: '示例追加', quantity: 1, unit_price: 1 })).rejects.toThrow();
    await stack.hooks
      .run(Contract.name, 'update', { id: created.id, amount: 1 }, { as: manager.token })
      .catch(() => undefined);
    expect(Number((await contract(created.id)).amount)).toBe(500000);
  });

  it('does not let a buyer change anything but the signed copy and date', async () => {
    const created = await draft(manager.token, { supplier: await supplier() });
    await stack.hooks
      .run(Contract.name, 'update', { id: created.id, title: '示例采购员改名' }, { as: buyer.token })
      .catch(() => undefined);
    expect((await contract(created.id)).title).not.toBe('示例采购员改名');
    await expect(draft(buyer.token, { supplier: await supplier() })).rejects.toThrow();
  });

  it('sets the supplier quality agreement flag while the agreement is active', async () => {
    const target = await supplier();
    const id = await activeContract({ supplier: target, contract_type: 'quality_agreement', start_date: day(-400), end_date: day(-1) });
    expect((await row(Supplier.name, target)).quality_agreement_signed).toBe(true);
    expect((await row(Supplier.name, target)).integrity_agreement_signed).toBe(false);
    await sweep();
    expect((await contract(id)).status).toBe('expired');
    expect((await row(Supplier.name, target)).quality_agreement_signed).toBe(false);
  });

  it('keeps the integrity flag while another integrity agreement is still active', async () => {
    const target = await supplier();
    const old = await activeContract({ supplier: target, contract_type: 'integrity', start_date: day(-400), end_date: day(-1) });
    await activeContract({ supplier: target, contract_type: 'integrity', start_date: day(-10), end_date: day(700) });
    await sweep();
    expect((await contract(old)).status).toBe('expired');
    expect((await row(Supplier.name, target)).integrity_agreement_signed).toBe(true);
  });

  it('expires an overdue contract once and leaves current ones alone', async () => {
    const overdue = await activeContract({ supplier: await supplier(), start_date: day(-365), end_date: day(-1) });
    const current = await activeContract({ supplier: await supplier(), start_date: day(-30), end_date: day(0) });
    await sweep();
    expect((await contract(overdue)).status).toBe('expired');
    expect((await contract(current)).status).toBe('active');
    const before = await contract(overdue);
    await sweep();
    expect((await contract(overdue)).updated_at).toBe(before.updated_at);
  });

  it('creates a renewal draft with copied lines for an auto-renew contract', async () => {
    const id = await draft(manager.token, { supplier: await supplier(), category, auto_renew: true, start_date: day(-365), end_date: day(-1) });
    await line(manager.token, id.id, { line_no: 1, description: '示例年度服务', quantity: 12, uom: '月', unit_price: 1000 });
    await stack.hooks.run(Contract.name, 'update', { id: id.id, status: 'in_review' }, { system: true });
    await toSigning(id.id);
    await stack.hooks.run(Contract.name, 'update', { id: id.id, signed_file: await signedFile(), signed_date: day(-366) }, { system: true });
    await stack.hooks.run(Contract.name, 'update', { id: id.id, status: 'active' }, { system: true });

    await sweep();
    await sweep();
    expect((await contract(id.id)).status).toBe('expired');
    const renewals = await stack.rows(Contract.name, { renewed_from: id.id });
    expect(renewals).toHaveLength(1);
    const renewal = renewals[0]!;
    expect(renewal).toMatchObject({ status: 'draft', auto_renew: true, start_date: day(0), end_date: day(364), category });
    expect(renewal.owner_id).toBe(manager.id);
    const lines = await stack.rows(ContractLine.name, { contract: String(renewal.id) });
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.amount)).toBe(12000);
  });

  it('expires an auto-renew contract without renewing when the supplier is frozen', async () => {
    const target = await supplier();
    const id = await activeContract({ supplier: target, auto_renew: true, start_date: day(-365), end_date: day(-1) });
    await stack.hooks.run(Supplier.name, 'update', { id: target, status: 'frozen' }, { system: true });
    await sweep();
    expect((await contract(id)).status).toBe('expired');
    expect(await stack.rows(Contract.name, { renewed_from: id })).toHaveLength(0);
    // 站内信异步投递
    await expect.poll(async () => (await inbox(manager.id, id)).length).toBe(1);
  });

  it('reminds the owner and the category manager 60, 30 and 7 days before expiry', async () => {
    const due = await activeContract({ supplier: await supplier(), category, start_date: day(-300), end_date: day(30) });
    const notDue = await activeContract({ supplier: await supplier(), category, start_date: day(-300), end_date: day(31) });
    // 没填主要品类的只通知所有者
    const noCategory = await activeContract({ supplier: await supplier(), start_date: day(-300), end_date: day(7) });
    const job = stack.kernel.getService<{ trigger(name: string): Promise<unknown> }>('job');
    await job.trigger('flow-time-relative:srm_contract_expiry_notice');
    await expect.poll(async () => (await inbox(manager.id, due)).length).toBeGreaterThan(0);
    await expect.poll(async () => (await inbox(otherManager.id, due)).length).toBe(1);
    expect(await stack.rows('sys_notification', { source_id: notDue })).toHaveLength(0);
    await expect.poll(async () => (await inbox(manager.id, noCategory)).length).toBe(1);
    // 同一提醒日再扫一次不重复发
    await job.trigger('flow-time-relative:srm_contract_expiry_notice');
    expect(await stack.rows('sys_notification', { source_id: due })).toHaveLength(1);
  });
});
