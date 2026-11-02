import { P } from '@objectstack/spec';
import { defineSharingRule } from '@objectstack/spec/security';
import { SrmPositions } from './positions.js';
import { PortalContractStatuses } from './portal-permission-sets.js';

// 共享规则：对象 OWD 保持 public_read（或 private）时，让某个岗位能改别人建的记录而不能删（objectstack#25470 的裁定写法）。
// 对象权限仍要有 allowEdit，共享只放宽「哪些行」，不放宽「哪些动作」；能改哪些字段仍由 allowEdit 与 FLS 决定。
// 条件不能是恒真（平台把恒真条件当作不匹配，ADR-0049），一律写成必填字段非空，覆盖对象的全部记录。

const positionLabel = (position: string) => {
  const label = SrmPositions.find((p) => p.name === position)!.label;
  return /[A-Za-z]$/.test(label) ? `${label} ` : label;
};

// 每个岗位一条规则：name = <对象>_edit_<岗位去掉 srm_ 前缀>
type Condition = Parameters<typeof defineSharingRule>[0]['condition'];
const editRules = (object: string, condition: Condition, action: string, positions: string[]) =>
  positions.map((position) =>
    defineSharingRule({
      name: `${object}_edit_${position.replace(/^srm_/, '')}`,
      label: `${positionLabel(position)}${action}`,
      object,
      type: 'criteria',
      condition,
      accessLevel: 'edit',
      sharedWith: { type: 'position', value: position },
    }),
  );

// 绩效指标库（02 §4.7，FR-701）：采购总监维护全部指标，包括系统种子建的示例指标。指标编码必填
export const KpiDirectorEdit = defineSharingRule({
  name: 'srm_kpi_director_edit',
  label: '采购总监维护绩效指标',
  object: 'srm_kpi',
  type: 'criteria',
  condition: P`record.code != ''`,
  accessLevel: 'edit',
  sharedWith: { type: 'position', value: 'srm_procurement_director' },
});

// 供应商（02 §4.1，04 §2.3）：供应商主数据在集团内共享，品类经理、采购主管、系统管理员改别人建的和存量导入的供应商；
// SQE、质量经理的编辑权只为写证书（controlled_by_parent 要求父记录可编辑），供应商字段经 FLS 全部只读。公司全称必填
export const SupplierEditRules = editRules('srm_supplier', P`record.name != ''`, '维护供应商', [
  'srm_category_manager',
  'srm_buyer_lead',
  'srm_sqe',
  'srm_quality_manager',
  'srm_admin',
]);

// 物料（02 §4.1）：ERP 物料的只读副本，由系统管理员导入（管理员可删，用 modifyAllRecords）；持 srm_buyer 的岗位
// 只改物料与品类的关联（FLS）。ERP 物料号必填
export const MaterialEditRules = editRules('srm_material', P`record.erp_material_no != ''`, '维护物料品类', [
  'srm_buyer',
  'srm_buyer_lead',
  'srm_procurement_director',
]);

// 合同（02 §4.4，04 §2.3）：OWD private，读靠权限集的 viewAllRecords。品类经理、采购主管互相接手草稿，
// 法务改草稿条款，持 srm_buyer 的岗位给别人建的合同上传签署件（FLS 只放开签署件与签署日期）。合同名称必填
export const ContractEditRules = editRules('srm_contract', P`record.title != ''`, '处理合同', [
  'srm_category_manager',
  'srm_buyer_lead',
  'srm_buyer',
  'srm_procurement_director',
  'srm_legal_counsel',
]);

// 准入申请（02 §4.2，03 §3）：OWD private，读靠权限集的 viewAllRecords。门户提交的申请由系统身份 flow 代建，属于提交的
// 门户用户（v0.6）；品类经理、采购主管要能受理、退回补充、指定初审人，也要能接手同事登记的申请。门户写不了申请（门户
// 权限集不授编辑），这里只放给持 srm_supplier_admin 的两个岗位。供应商必填
export const ApplicationEditRules = editRules('srm_supplier_application', P`record.supplier != ''`, '处理准入申请', [
  'srm_category_manager',
  'srm_buyer_lead',
]);

// 整改单（02 §4.6，03 §8）：自动开的单属于系统，SQE 之间要互相接手；应付会计只改索赔状态（FLS）。来源必填
export const QualityIssueEditRules = editRules('srm_quality_issue', P`record.source != ''`, '处理整改单', [
  'srm_sqe',
  'srm_quality_manager',
  'srm_ap_accountant',
]);

// 供应商审核（02 §4.6，FR-607）：OWD private，读靠权限集的 viewAllRecords。年度计划由系统生成，SQE 之间要互相接手；
// 问题项 controlled_by_parent，随审核一起可改。审核类型必填
export const SupplierAuditEditRules = editRules('srm_supplier_audit', P`record.audit_type != ''`, '执行供应商审核', [
  'srm_sqe',
  'srm_quality_manager',
]);

// 风险事件（02 §4.9，04 §2.3）：品类经理、采购主管、SQE、质量经理登记和处理风险事件，要能接手别人登记的和系统生成的
// 事件。事件描述必填
export const RiskEventEditRules = editRules('srm_risk_event', P`record.description != ''`, '处理风险事件', [
  'srm_category_manager',
  'srm_buyer_lead',
  'srm_sqe',
  'srm_quality_manager',
]);

// 门户读（v0.6，ADR-0010）：external 成员对 private 对象只能读自己拥有的和共享给它的行，门户 RLS 解除不了这个下限，
// 所以准入申请、变更单、合同各有一条只授 srm_portal_user 的读共享规则。共享规则本身放给全体门户用户，行范围由
// srm_portal_supplier 上读成员键的 RLS 限定到本公司——两把锁缺一不可，test/portal-isolation.test.ts 守着这一点。
// 合同只共享门户可见的状态（04 §3.2），草稿与审批中的合同连共享都不进
const portalRead = (object: string, condition: Condition, label: string) =>
  defineSharingRule({
    name: `${object}_portal_read`,
    label,
    object,
    type: 'criteria',
    condition,
    accessLevel: 'read',
    sharedWith: { type: 'position', value: 'srm_portal_user' },
  });

export const PortalReadRules = [
  portalRead('srm_supplier_application', P`record.supplier != ''`, '门户查看本公司准入申请'),
  portalRead('srm_supplier_change_request', P`record.supplier != ''`, '门户查看本公司变更单'),
  portalRead(
    'srm_contract',
    { dialect: 'cel', source: `record.status in [${PortalContractStatuses.map((s) => `'${s}'`).join(', ')}]` },
    '门户查看本公司合同',
  ),
];

export const SrmSharingRules = [
  KpiDirectorEdit,
  ...SupplierEditRules,
  ...MaterialEditRules,
  ...ContractEditRules,
  ...ApplicationEditRules,
  ...QualityIssueEditRules,
  ...SupplierAuditEditRules,
  ...RiskEventEditRules,
  ...PortalReadRules,
];
