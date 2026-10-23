import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootStack, type VerifyStack } from '@objectstack/verify';
import config from '../objectstack.config';
import { Category, Supplier, SupplierApplication, SupplierCategory } from '../src/core/objects';

// P1 准入（03 §3）的 v0.1 版本：受理 → 资料审核 → 两级审批 → 合格 / 退回 / 未通过。
describe('supplier admission', () => {
  let stack: VerifyStack;
  let admin: string;
  let adminId: string;
  let seq = 0;

  const newSupplier = () =>
    stack.hooks.run(
      Supplier.name,
      'insert',
      { name: `准入测试供应商 ${++seq}`, credit_code: `91000000MA0ADM${String(seq).padStart(4, '0')}` },
      { as: admin },
    );
  const newCategory = () =>
    stack.hooks.run(Category.name, 'insert', { code: `ADM${++seq}`, name: `准入测试品类 ${seq}` }, { as: admin });
  const read = async (object: string, id: string) => (await stack.rows(object, { id }, { as: admin }))[0]!;
  const update = (object: string, doc: Record<string, unknown>) => stack.hooks.run(object, 'update', doc, { as: admin });

  // 当前待决的审批请求
  const pendingRequest = async (recordId: string) => {
    const rows = await stack.rows('sys_approval_request', { record_id: recordId });
    return rows.find((r) => r.status === 'pending');
  };
  const decide = async (recordId: string, verdict: 'approve' | 'reject') => {
    const request = await pendingRequest(recordId);
    expect(request, 'no pending approval request').toBeTruthy();
    const res = await stack.apiAs(admin, 'POST', `/approvals/requests/${request!.id}/${verdict}`, { comment: verdict });
    expect(res.status, await res.clone().text()).toBe(200);
  };

  const applyFor = async (categories: string[]) => {
    const supplier = await newSupplier();
    const app = await stack.hooks.run(
      SupplierApplication.name,
      'insert',
      { supplier: supplier.id, applied_categories: categories, reviewer: adminId },
      { as: admin },
    );
    return { supplier: supplier.id as string, app: app.id as string };
  };

  beforeAll(async () => {
    stack = await bootStack(config);
    admin = await stack.signIn();
    const [me] = await stack.rows('sys_user', {});
    adminId = String(me!.id);
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('moves a new application to document review and the supplier to qualifying', async () => {
    const category = await newCategory();
    const { supplier, app } = await applyFor([category.id]);
    expect((await read(SupplierApplication.name, app)).status).toBe('doc_review');
    expect((await read(Supplier.name, supplier)).status).toBe('qualifying');
  });

  it('refuses an application for a supplier that is already qualifying', async () => {
    const category = await newCategory();
    const { supplier } = await applyFor([category.id]);
    await expect(
      stack.hooks.run(SupplierApplication.name, 'insert', { supplier, applied_categories: [category.id] }, { as: admin }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('qualifies the supplier and its categories after both approvals', async () => {
    const [a, b] = [await newCategory(), await newCategory()];
    const { supplier, app } = await applyFor([a.id, b.id]);
    await update(SupplierApplication.name, { id: app, status: 'admission_review' });

    await decide(app, 'approve');
    expect((await read(SupplierApplication.name, app)).status).toBe('admission_review');
    await decide(app, 'approve');

    const application = await read(SupplierApplication.name, app);
    expect(application.status).toBe('approved');
    expect(application.approved_date).toBeTruthy();
    expect((await read(Supplier.name, supplier)).status).toBe('qualified');
    const grants = await stack.rows(SupplierCategory.name, { supplier }, { as: admin });
    expect(grants.map((g) => g.category).sort()).toEqual([a.id, b.id].sort());
    expect(grants.every((g) => g.status === 'qualified')).toBe(true);
  });

  it('returns the application to document review when an approver rejects', async () => {
    const category = await newCategory();
    const { supplier, app } = await applyFor([category.id]);
    await update(SupplierApplication.name, { id: app, status: 'admission_review' });
    await decide(app, 'reject');
    expect((await read(SupplierApplication.name, app)).status).toBe('doc_review');
    expect((await read(Supplier.name, supplier)).status).toBe('qualifying');
  });

  it('sends the supplier back to potential when the application is rejected', async () => {
    const category = await newCategory();
    const { supplier, app } = await applyFor([category.id]);
    await expect(update(SupplierApplication.name, { id: app, status: 'rejected' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await update(SupplierApplication.name, { id: app, status: 'rejected', reject_reason: '资质不全' });
    expect((await read(Supplier.name, supplier)).status).toBe('potential');
  });
});
