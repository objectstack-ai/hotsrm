import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 1–2（03 §3）的内部登记版本：申请建立后按关联供应商的状态写查重结论。
// - 黑名单：申请直接未通过并通知申请人（BR-02），供应商状态不动；
// - 淘汰：重新准入（FR-208），沿用旧档，供应商回到「准入中」，品类资格在批准后按申请品类恢复；
// - 潜在：通过，供应商进入「准入中」。
// 内部登记时供应商已由唯一约束查重，其余状态在建申请时被校验规则拦下，所以这里不会出现 duplicate。
// 查重前先把申请品类中最高的物资类别和风险等级复制到申请（03 §3 步骤 1），准入审批据此决定是否会签质量经理。
// 申请品类中任找一条满足条件的品类；找不到时输出变量为 null
const categoryWith = (id: string, label: string, where: Record<string, string>, outputVariable: string) => ({
  id,
  type: 'get_record' as const,
  label,
  config: {
    objectName: 'srm_category',
    filter: { id: { $in: cel`record.applied_categories` }, ...where },
    outputVariable,
  },
});

export const ApplicationIntakeFlow: Automation.Flow = {
  name: 'srm_application_intake',
  label: '准入申请受理',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '申请已提交',
      config: { objectName: 'srm_supplier_application', triggerType: 'record-after-create' },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, outputVariable: 'vendor' },
    },
    categoryWith('find_class_a', '找 A 类申请品类', { material_class: 'class_a' }, 'classA'),
    categoryWith('find_class_b', '找 B 类申请品类', { material_class: 'class_b' }, 'classB'),
    categoryWith('find_risk_high', '找高风险申请品类', { risk_class: 'high' }, 'riskHigh'),
    categoryWith('find_risk_medium', '找中风险申请品类', { risk_class: 'medium' }, 'riskMedium'),
    {
      id: 'copy_classes',
      type: 'update_record',
      label: '写入最高物资类别与风险等级',
      config: {
        objectName: 'srm_supplier_application',
        filter: { id: cel`record.id` },
        fields: {
          material_class: cel`classA != null ? 'class_a' : (classB != null ? 'class_b' : 'class_c')`,
          risk_class: cel`riskHigh != null ? 'high' : (riskMedium != null ? 'medium' : 'low')`,
        },
      },
    },
    { id: 'by_status', type: 'decision', label: '按供应商状态查重' },
    {
      id: 'reject_blacklisted',
      type: 'update_record',
      label: '黑名单：申请未通过',
      config: {
        objectName: 'srm_supplier_application',
        filter: { id: cel`record.id` },
        fields: {
          status: 'rejected',
          duplicate_check: 'blacklisted',
          reject_reason: '供应商在黑名单中，不得重新准入（BR-02）',
        },
      },
    },
    {
      id: 'notify_blacklisted',
      type: 'notify',
      label: '通知申请人：已自动驳回',
      config: {
        recipients: cel`record.created_by`,
        title: '准入申请 {{ record.application_no }} 已自动驳回',
        message: '{{ vendor.name }} 在黑名单中，不得重新准入。解除黑名单需另行发起处置单审批。',
        severity: 'warning',
        sourceObject: 'srm_supplier_application',
        sourceId: cel`record.id`,
      },
    },
    {
      id: 'mark_reapply',
      type: 'update_record',
      label: '淘汰：重新准入',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.id` }, fields: { duplicate_check: 'reapply' } },
    },
    {
      id: 'mark_pass',
      type: 'update_record',
      label: '查重通过',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.id` }, fields: { duplicate_check: 'pass' } },
    },
    {
      id: 'supplier_qualifying',
      type: 'update_record',
      label: '供应商进入准入中',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'qualifying' } },
    },
    {
      id: 'to_doc_review',
      type: 'update_record',
      label: '申请进入资料审核',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.id` }, fields: { status: 'doc_review' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'load_supplier', type: 'default' },
    { id: 'e2', source: 'load_supplier', target: 'find_class_a', type: 'default' },
    { id: 'e_c1', source: 'find_class_a', target: 'find_class_b', type: 'default' },
    { id: 'e_c2', source: 'find_class_b', target: 'find_risk_high', type: 'default' },
    { id: 'e_c3', source: 'find_risk_high', target: 'find_risk_medium', type: 'default' },
    { id: 'e_c4', source: 'find_risk_medium', target: 'copy_classes', type: 'default' },
    { id: 'e_c5', source: 'copy_classes', target: 'by_status', type: 'default' },
    {
      id: 'e_blacklisted',
      source: 'by_status',
      target: 'reject_blacklisted',
      type: 'conditional',
      condition: P`vendor.status == 'blacklisted'`,
      label: '黑名单',
    },
    { id: 'e_b1', source: 'reject_blacklisted', target: 'notify_blacklisted', type: 'default' },
    { id: 'e_b2', source: 'notify_blacklisted', target: 'end', type: 'default' },
    {
      id: 'e_eliminated',
      source: 'by_status',
      target: 'mark_reapply',
      type: 'conditional',
      condition: P`vendor.status == 'eliminated'`,
      label: '淘汰',
    },
    {
      id: 'e_potential',
      source: 'by_status',
      target: 'mark_pass',
      type: 'conditional',
      condition: P`vendor.status != 'blacklisted' && vendor.status != 'eliminated'`,
      label: '潜在',
    },
    { id: 'e_r1', source: 'mark_reapply', target: 'supplier_qualifying', type: 'default' },
    { id: 'e_p1', source: 'mark_pass', target: 'supplier_qualifying', type: 'default' },
    { id: 'e3', source: 'supplier_qualifying', target: 'to_doc_review', type: 'default' },
    { id: 'e4', source: 'to_doc_review', target: 'end', type: 'default' },
  ],
};
