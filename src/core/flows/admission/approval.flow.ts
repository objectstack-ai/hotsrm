import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';

// P1 步骤 6–7（03 §3）：申请进入「准入评审」时发起两级审批。
// 第 1 级是申请上的初审人，第 2 级是采购总监岗位；任一级驳回，申请退回「资料审核」。
// 批准后：申请→准入通过，供应商→合格，按申请品类建供货品类资格（v0.1 没有现场审核，一律合格）。
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
                          status: 'qualified',
                          approved_date: cel`today()`,
                        },
                      },
                    },
                  ],
                },
                // 重新准入的供应商可能已有该品类的资格记录（唯一约束），改为恢复合格
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
                        fields: { status: 'qualified', approved_date: cel`today()` },
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
    { id: 'e1', source: 'start', target: 'review_reviewer', type: 'default' },
    { id: 'e2', source: 'review_reviewer', target: 'review_director', type: 'default', label: 'approve' },
    { id: 'e3', source: 'review_reviewer', target: 'back_to_doc_review', type: 'default', label: 'reject' },
    { id: 'e4', source: 'review_director', target: 'mark_approved', type: 'default', label: 'approve' },
    { id: 'e5', source: 'review_director', target: 'back_to_doc_review', type: 'default', label: 'reject' },
    { id: 'e6', source: 'mark_approved', target: 'supplier_qualified', type: 'default' },
    { id: 'e7', source: 'supplier_qualified', target: 'each_category', type: 'default' },
    { id: 'e8', source: 'each_category', target: 'end', type: 'default' },
    { id: 'e9', source: 'back_to_doc_review', target: 'end', type: 'default' },
  ],
};
