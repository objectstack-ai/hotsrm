import { Supplier } from '../objects/supplier.object.js';
import { SupplierBankAccount } from '../objects/supplier-bank-account.object.js';

// 门户权限集（04 §3.2、§3.4，ADR-0010）。门户用户按组织角色 external 邀请，任命到静态岗位 srm_portal_user
// （门户管理员再加 srm_portal_admin）；能看哪家供应商只由成员键 current_user.portal_supplier_ids 决定，
// 它来自联系人上的 portal_user（02 §4.1）。一律不设 isDefault（AGENTS.md 红线 2）。
//
// 隔离靠三层，缺一层都只会少看，不会多看：
// 1. 每条门户 RLS 都读成员键：键取不到、为空或出错时平台丢弃该策略并拒绝（fail-closed）；
// 2. external 成员对 OWD 一律按「仅本人」处理，门户 RLS 只在 public_read 对象上解除这个下限；
//    private 对象（准入申请、变更单、合同）另由只授门户岗位的读共享规则放行，RLS 再限定到本公司；
// 3. controlled_by_parent 子对象（联系人、证书、银行账户、品类资格、合同明细、评分明细）跟随主记录，
//    新建、改挂主记录都要求对主记录可编辑。

const OWN = 'supplier in current_user.portal_supplier_ids';
// 门户能看到的合同状态：草稿、审批中、审批未通过的合同不可见（04 §3.2）
export const PortalContractStatuses = ['signing', 'active', 'expired', 'terminated'];
// 门户能看到的考评单状态：发布后才可见；申诉只能对已发布的考评提起，申诉期间照常可见（04 §3.2）
export const PortalReviewStatuses = ['published', 'appealed'];
const list = (values: string[]) => `[${values.map((v) => `'${v}'`).join(', ')}]`;

const none = { allowCreate: false, allowRead: true, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false };
const readOnly = { readable: true, editable: false };
const hidden = { readable: false, editable: false };

// 供应商档案：门户只能改资料字段（04 §4.2），关键信息走变更单；内部评估类字段门户不可见。
// 临时：risk_level 暂时可读——平台的默认搜索会扫描选项字段而不跳过调用者读不到的字段，隐藏它会让门户的供应商搜索
// 整体被拒（objectstack#25672，主干已修、18.1.0 未含），升级到含修复的版本后加回隐藏
const supplierEditable = new Set(['short_name', 'website', 'supplier_type', 'taxpayer_type', 'established_date']);
const supplierHidden = new Set([
  'is_related_party',
  'preferred',
  'open_risk_event_count',
  'open_disposition_count',
  'legacy_imported',
  'legacy_reviewed',
  'last_change_request',
]);
const supplierFields = Object.fromEntries(
  Object.keys(Supplier.fields)
    .filter((field) => !supplierEditable.has(field))
    .map((field) => [`srm_supplier.${field}`, supplierHidden.has(field) ? hidden : readOnly]),
);

// 证书：门户上传和修改证书（v0.6 U4）；状态、强制标志、核验结论只由 flow 与「核验证书」写入（防止自解资质异常，04 §3.7）。
// 门户改了证书内容，srm_certificate_change_check 把「已核验」复位并通知 SQE，核验前不能解除资质异常（03 §11）
const certificateFlowOwned = ['status', 'is_mandatory', 'verified', 'verified_by', 'legacy_imported'];
const certificateFields = Object.fromEntries(certificateFlowOwned.map((field) => [`srm_supplier_certificate.${field}`, readOnly]));

export const PortalSupplierPermissionSet = {
  name: 'srm_portal_supplier',
  label: '供应商门户用户',
  objects: {
    // 授予编辑权是为了资料字段和证书（controlled_by_parent 要求主记录可编辑）；其余字段 FLS 只读
    srm_supplier: { ...none, allowEdit: true },
    srm_supplier_contact: none,
    srm_supplier_certificate: { ...none, allowCreate: true, allowEdit: true },
    srm_supplier_category: none,
    srm_supplier_bank_account: none,
    srm_supplier_application: none,
    srm_supplier_change_request: none,
    srm_contract: none,
    srm_contract_line: none,
    srm_delivery_record: none,
    srm_quality_issue: none,
    srm_performance_review: none,
    srm_performance_score: none,
  },
  // 门户应用和门户按钮的显示（体验，不是数据边界）
  systemPermissions: ['srm_portal_access'],
  fields: {
    ...supplierFields,
    ...certificateFields,
    // 联系人：在职标志也是成员键的过滤条件，门户不能自己恢复一个被停用的账号
    'srm_supplier_contact.active': readOnly,
    'srm_supplier_contact.mobile': readOnly,
    'srm_quality_issue.sqe_comment': readOnly,
    'srm_quality_issue.claim_amount': readOnly,
  },
  rowLevelSecurity: [
    { name: 'srm_portal_supplier_read', object: 'srm_supplier', operation: 'select', using: 'id in current_user.portal_supplier_ids' },
    {
      name: 'srm_portal_supplier_write',
      object: 'srm_supplier',
      operation: 'update',
      using: 'id in current_user.portal_supplier_ids',
      check: 'id in current_user.portal_supplier_ids',
    },
    { name: 'srm_portal_application_read', object: 'srm_supplier_application', operation: 'select', using: OWN },
    { name: 'srm_portal_change_request_read', object: 'srm_supplier_change_request', operation: 'select', using: OWN },
    {
      name: 'srm_portal_contract_read',
      object: 'srm_contract',
      operation: 'select',
      using: `${OWN} && status in ${list(PortalContractStatuses)}`,
    },
    { name: 'srm_portal_delivery_read', object: 'srm_delivery_record', operation: 'select', using: OWN },
    { name: 'srm_portal_quality_issue_read', object: 'srm_quality_issue', operation: 'select', using: OWN },
    {
      name: 'srm_portal_review_read',
      object: 'srm_performance_review',
      operation: 'select',
      using: `${OWN} && status in ${list(PortalReviewStatuses)}`,
    },
  ],
};

// 门户管理员（按人授予，04 §3.3）：在本公司下新增、修改联系人，新增银行账户，看完整银行账号（04 §4.2）；
// 关键信息只经「提交变更申请」（srm_change_submit）提交，被退回修改的本人变更单可以改完重新提交（v0.6 U4）。
// 与 srm_portal_supplier 同时持有；本身不授读，行范围仍由门户 RLS 和主记录决定
const bankFlowOwned = Object.fromEntries(
  Object.entries(SupplierBankAccount.fields)
    .filter(([, field]) => (field as { readonly?: boolean }).readonly)
    .map(([name]) => [`srm_supplier_bank_account.${name}`, readOnly]),
);

export const PortalAdminPermissionSet = {
  name: 'srm_portal_admin',
  label: '供应商门户管理员',
  objects: {
    srm_supplier_contact: { ...none, allowCreate: true, allowEdit: true },
    srm_supplier_bank_account: { ...none, allowCreate: true },
    // 只为退回修改：变更单是 private，external 成员只能改自己发起（拥有）的行；下面的写策略再限定到本公司、被退回的单。
    // 变更内容字段的 readonlyWhen 让它们只在退回期间可改，供应商、类型、状态与审批字段对谁都只读（对象定义）
    srm_supplier_change_request: { ...none, allowEdit: true },
  },
  systemPermissions: ['srm_view_bank_account_no', 'srm_portal_manage'],
  rowLevelSecurity: [
    {
      name: 'srm_portal_change_request_revise',
      object: 'srm_supplier_change_request',
      operation: 'update' as const,
      using: `${OWN} && approval_status == 'returned'`,
      check: OWN,
    },
  ],
  fields: {
    'srm_supplier_contact.mobile': { readable: true, editable: true },
    'srm_supplier_contact.active': readOnly,
    ...bankFlowOwned,
  },
};

export const SrmPortalPermissionSets = [PortalSupplierPermissionSet, PortalAdminPermissionSet];
