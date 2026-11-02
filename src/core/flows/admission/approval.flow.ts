import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 6–7（03 §3）：申请进入「准入评审」时发起两级审批。
// 第 1 级是申请上的初审人，第 2 级是采购总监岗位；A 类物资或高风险品类的申请第 2 级并行加质量经理会签
// （03 §12）：采购总监、质量经理各一人通过才算通过（per_group，同岗位多人时任一人即可），任一人驳回即驳回。
// 任一级驳回，申请退回「资料审核」。
// 职责分离（07 §2.1 第 4 步，03 §12）：初审人就是申请的新建人或把申请推进到准入评审的人时，品类经理一级
// 上提给采购总监、与第 2 级合并（同合同、处置单的做法），申请上 review_escalated 记为 true。不要求「另一位
// 品类经理」：只有一位品类经理的品类会卡住。平台审批服务没有「提交人不得审批」的开关（objectstack#25446）。
// 批准后：申请→准入通过，供应商→合格，按申请品类建供货品类资格：现场审核结论为有条件通过时为「试供」，
// 否则为「合格」（03 §3 第 7 步，WI-01 6.6.2）。

const cel$ = (source: string) => ({ dialect: 'cel' as const, source });
// v0.4 之前受理的申请没有这两个字段，按不会签处理
const grantStatus = cel`has(record.audit_result) && record.audit_result == 'conditional' ? 'trial' : 'qualified'`;
// 推进到准入评审的人：触发这次 flow 的更新写入的 updated_by
const selfReview = `has(record.reviewer) && record.reviewer != null && ((has(record.created_by) && record.reviewer == record.created_by) || (has(record.updated_by) && record.reviewer == record.updated_by))`;
const needsQuality = `(has(record.material_class) && record.material_class == 'class_a') || (has(record.risk_class) && record.risk_class == 'high')`;

export const AdmissionApprovalFlow: Automation.Flow = {
  name: 'srm_admission_approval',
  label: '准入评审',
  type: 'record_change',
  status: 'active',
  runAs: 'system',

  nodes: [
    {
      id: 'start',
      type: 'start',
      label: '进入准入评审',
      config: {
        objectName: 'srm_supplier_application',
        triggerType: 'record-after-update',
        condition: P`record.status == 'admission_review' && has(previous.status) && previous.status != 'admission_review'`,
      },
    },
    { id: 'check_self', type: 'assignment', label: '初审人是发起人？', config: { assignments: { selfReview: cel$(selfReview) } } },
    {
      id: 'mark_escalation',
      type: 'update_record',
      label: '记录品类经理一级是否上提',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.id` }, fields: { review_escalated: cel`selfReview` } },
    },
    { id: 'route_reviewer', type: 'decision', label: '品类经理一级由谁审批？' },
    {
      id: 'review_reviewer',
      type: 'approval',
      label: '初审人审批',
      config: {
        approvers: [{ type: 'field', value: 'reviewer' }],
        onEmptyApprovers: 'admin_rescue',
        behavior: 'first_response',
        lockRecord: true,
        approvalStatusField: 'approval_status',
      },
    },
    {
      id: 'review_director',
      type: 'approval',
      label: '采购总监审批',
      config: {
        approvers: [{ type: 'position', value: 'srm_procurement_director' }],
        // 岗位没人时交给组织管理员，避免申请卡在锁定状态
        onEmptyApprovers: 'admin_rescue',
        behavior: 'first_response',
        lockRecord: true,
        approvalStatusField: 'approval_status',
      },
    },
    { id: 'needs_quality', type: 'decision', label: 'A 类或高风险？' },
    {
      id: 'review_director_quality',
      type: 'approval',
      label: '采购总监 + 质量经理会签',
      config: {
        approvers: [
          { type: 'position', value: 'srm_procurement_director', group: 'director' },
          { type: 'position', value: 'srm_quality_manager', group: 'quality' },
        ],
        // 某个岗位没人时，该岗位的会签由组织管理员代为决定（待决审批人里留下 position:… 槽）
        onEmptyApprovers: 'admin_rescue',
        behavior: 'per_group',
        lockRecord: true,
        approvalStatusField: 'approval_status',
      },
    },
    {
      id: 'mark_approved',
      type: 'update_record',
      label: '申请准入通过',
      config: {
        objectName: 'srm_supplier_application',
        filter: { id: cel`record.id` },
        fields: { status: 'approved', approved_date: cel`today()` },
      },
    },
    {
      id: 'supplier_qualified',
      type: 'update_record',
      label: '供应商合格',
      config: { objectName: 'srm_supplier', filter: { id: cel`record.supplier` }, fields: { status: 'qualified' } },
    },
    {
      id: 'each_category',
      type: 'loop',
      label: '逐个申请品类',
      config: {
        collection: cel`record.applied_categories`,
        iteratorVariable: 'categoryId',
        body: {
          nodes: [
            {
              id: 'guard_category',
              type: 'try_catch',
              label: '单个品类',
              config: {
                try: {
                  nodes: [
                    {
                      id: 'grant_category',
                      type: 'create_record',
                      label: '建供货品类资格',
                      config: {
                        objectName: 'srm_supplier_category',
                        fields: {
                          supplier: cel`record.supplier`,
                          category: cel`categoryId`,
                          status: grantStatus,
                          approved_date: cel`today()`,
                        },
                      },
                    },
                  ],
                },
                // 重新准入的供应商可能已有该品类的资格记录（唯一约束），改为恢复
                catch: {
                  nodes: [
                    {
                      id: 'restore_category',
                      type: 'update_record',
                      label: '恢复已有品类资格',
                      config: {
                        objectName: 'srm_supplier_category',
                        filter: { supplier: cel`record.supplier`, category: cel`categoryId` },
                        // 按条件更新要声明 multi；供应商 + 品类唯一，实际只有一条
                        multi: true,
                        fields: { status: grantStatus, approved_date: cel`today()` },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
    {
      id: 'back_to_doc_review',
      type: 'update_record',
      label: '退回资料审核',
      config: { objectName: 'srm_supplier_application', filter: { id: cel`record.id` }, fields: { status: 'doc_review' } },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e1', source: 'start', target: 'check_self', type: 'default' },
    { id: 'e_check', source: 'check_self', target: 'mark_escalation', type: 'default' },
    { id: 'e_route', source: 'mark_escalation', target: 'route_reviewer', type: 'default' },
    { id: 'e_reviewer', source: 'route_reviewer', target: 'review_reviewer', type: 'conditional', condition: P`selfReview != true`, label: '初审人审批' },
    {
      id: 'e_escalate',
      source: 'route_reviewer',
      target: 'needs_quality',
      type: 'conditional',
      condition: P`selfReview == true`,
      label: '初审人是发起人：上提采购总监',
    },
    { id: 'e2', source: 'review_reviewer', target: 'needs_quality', type: 'default', label: 'approve' },
    {
      id: 'e_quality',
      source: 'needs_quality',
      target: 'review_director_quality',
      type: 'conditional',
      condition: cel$(needsQuality),
      label: '会签质量经理',
    },
    {
      id: 'e_director',
      source: 'needs_quality',
      target: 'review_director',
      type: 'conditional',
      condition: cel$(`!(${needsQuality})`),
      label: '采购总监',
    },
    { id: 'e_q1', source: 'review_director_quality', target: 'mark_approved', type: 'default', label: 'approve' },
    { id: 'e_q2', source: 'review_director_quality', target: 'back_to_doc_review', type: 'default', label: 'reject' },
    { id: 'e3', source: 'review_reviewer', target: 'back_to_doc_review', type: 'default', label: 'reject' },
    { id: 'e4', source: 'review_director', target: 'mark_approved', type: 'default', label: 'approve' },
    { id: 'e5', source: 'review_director', target: 'back_to_doc_review', type: 'default', label: 'reject' },
    { id: 'e6', source: 'mark_approved', target: 'supplier_qualified', type: 'default' },
    { id: 'e7', source: 'supplier_qualified', target: 'each_category', type: 'default' },
    { id: 'e8', source: 'each_category', target: 'end', type: 'default' },
    { id: 'e9', source: 'back_to_doc_review', target: 'end', type: 'default' },
  ],
};
