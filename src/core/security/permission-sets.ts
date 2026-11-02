import { Supplier } from '../objects/supplier.object.js';
import { Contract } from '../objects/contract.object.js';
import { QualityIssue } from '../objects/quality-issue.object.js';
import { PerformanceReview } from '../objects/performance-review.object.js';

// 内部权限集（04 §2.2）的 v0.1 子集。一律不设 isDefault（AGENTS.md 红线 2）。
// 状态类字段（供应商状态、资质异常、证书状态）只由 flow 写入，权限集里一律只读。

const read = { allowCreate: false, allowRead: true, allowEdit: false, allowDelete: false, viewAllRecords: true, modifyAllRecords: false };
const write = { allowCreate: true, allowRead: true, allowEdit: true, allowDelete: false, viewAllRecords: true, modifyAllRecords: false };
const flowOwned = { readable: true, editable: false };
// 存量导入标记只由系统管理员在导入时写入：品类经理和 SQE 写不了，避免绕过准入直接建「合格」供应商
const importOwned = {
  'srm_supplier.legacy_imported': flowOwned,
  'srm_supplier_certificate.legacy_imported': flowOwned,
};
const readOnly = { readable: true, editable: false };

// 内部员工的基础：读基础数据与供应商主数据
export const InternalBasePermissionSet = {
  name: 'srm_internal_base',
  label: 'SRM 内部基础',
  objects: {
    srm_category: read,
    srm_plant: read,
    srm_material: read,
    srm_supplier: read,
    srm_supplier_contact: read,
    srm_supplier_certificate: read,
    srm_supplier_category: read,
    srm_supplier_bank_account: read,
    // 采购员按已执行的处置单在 ERP 同步冻结标志（v0.3）
    srm_supplier_disposition: read,
    // 交付记录内部只读（02 §4.6）：采购员、品类经理看 OTD 与不合格交付
    srm_delivery_record: read,
    // 整改单内部只读（04 §2.3）
    srm_quality_issue: read,
    // 供应商审核内部只读：品类经理推进准入时看审核结论（v0.4）
    srm_supplier_audit: read,
    srm_supplier_audit_finding: read,
    // 风险事件内部只读（04 §2.3），品类经理与 SQE 登记和处理（v0.5）
    srm_risk_event: read,
    // 绩效指标库内部只读（v0.5）：评分人按评分规则说明打分
    srm_kpi: read,
    // 考评单与评分明细内部只读（04 §2.3）：由 flow 生成和推进，评分只经「提交评分」screen flow（v0.5 P3）
    srm_performance_review: read,
    srm_performance_score: read,
  },
};

const contractFieldsReadOnly = Object.fromEntries(Object.keys(Contract.fields).map((field) => [`srm_contract.${field}`, readOnly]));
// 采购主管同时挂 srm_buyer 与 srm_supplier_admin：字段权限按「最宽」合并，但只在写了该字段的权限集之间合并，
// srm_supplier_admin 不写就只剩 srm_buyer 的只读，采购主管就起草不了合同。这里显式写可改；字段本身的 readonly
// 与 readonlyWhen 照常生效
const contractFieldsEditable = Object.fromEntries(
  Object.keys(Contract.fields).map((field) => [`srm_contract.${field}`, { readable: true, editable: true }]),
);
// 协议标志由 srm_contract_agreement_recalc 维护
const agreementFlags = {
  'srm_supplier.quality_agreement_signed': flowOwned,
  'srm_supplier.integrity_agreement_signed': flowOwned,
};

// 采购员：物料是 ERP 的只读副本（ADR-0008），采购员只维护物料与品类的关联，不新建、不删除
export const BuyerPermissionSet = {
  name: 'srm_buyer',
  label: 'SRM 采购',
  objects: {
    srm_material: { ...read, allowEdit: true },
    // 代供应商发起信息变更（v0.6 前）；改只限自己发起、被退回修改的变更单（对象上的 readonlyWhen）。
    // 采购员没有完整账号的读写能力，银行账户变更由品类经理或采购主管发起
    srm_supplier_change_request: { ...write },
    // 合同只读，签署中上传签署件、填签署日期（04 §2.3）；改别人建的合同靠共享规则 srm_contract_edit_*，
    // 其余字段 FLS 只读
    srm_contract: { ...read, allowEdit: true },
    srm_contract_line: read,
  },
  fields: {
    ...contractFieldsReadOnly,
    'srm_contract.signed_file': { readable: true, editable: true },
    'srm_contract.signed_date': { readable: true, editable: true },
    'srm_material.erp_material_no': readOnly,
    'srm_material.material_code': readOnly,
    'srm_material.name': readOnly,
    'srm_material.specification': readOnly,
    'srm_material.uom': readOnly,
    'srm_material.active': readOnly,
  },
};

// 品类经理等：维护供应商档案与子信息，发起和推进准入申请
export const SupplierAdminPermissionSet = {
  name: 'srm_supplier_admin',
  label: 'SRM 供应商管理',
  objects: {
    srm_supplier: write,
    srm_supplier_contact: { ...write, allowDelete: true },
    srm_supplier_certificate: write,
    srm_supplier_category: write,
    srm_supplier_application: write,
    // 发起信息变更；银行账户变更要填完整账号，只有持 srm_view_bank_account_no 的岗位能发起（BR-20）
    srm_supplier_change_request: write,
    // 新建账户后为「待核验」并锁定；核验只经 srm_bank_verify，已有账户的修改走信息变更单（v0.2 M4）
    srm_supplier_bank_account: write,
    // 起草合同与明细；状态只经 flow 推进（提交审批、确认生效、到期扫描）
    srm_contract: write,
    srm_contract_line: write,
    // 发起冻结 / 解冻 / 淘汰 / 黑名单；新建即进入审批，改只限被退回修改期间（对象上的 readonlyWhen，v0.3）
    srm_supplier_disposition: write,
    // 登记与处理风险事件（04 §2.3，v0.5）；来源、相关证书、处置单只由 flow 写入（对象上的 readonly）
    srm_risk_event: write,
  },
  // 银行账号完整可读（BR-20，04 §4.2）
  systemPermissions: ['srm_view_bank_account_no'],
  fields: {
    ...contractFieldsEditable,
    'srm_supplier.status': flowOwned,
    'srm_supplier.qualification_alert': flowOwned,
    'srm_supplier_certificate.status': flowOwned,
    'srm_supplier_category.status': flowOwned,
    'srm_supplier_category.approved_date': flowOwned,
    ...agreementFlags,
    'srm_supplier_category.status_before_freeze': flowOwned,
    'srm_supplier_category.freeze_scope': flowOwned,
    'srm_supplier_category.freeze_disposition': flowOwned,
    // 现场审核结论由 srm_audit_admission_apply 写回（FR-204）
    'srm_supplier_application.audit_passed': flowOwned,
    'srm_supplier_application.audit_result': flowOwned,
    ...importOwned,
  },
};

// 共享规则 srm_supplier_edit_* 让 SQE 能编辑所有供应商：
// SQE 的编辑权只为写证书（controlled_by_parent 要求父记录可编辑，04 §2.3），供应商字段全部只读
const supplierFieldsReadOnly = Object.fromEntries(Object.keys(Supplier.fields).map((field) => [`srm_supplier.${field}`, readOnly]));

// SQE：v0.1 由 SQE 维护证书（门户版本改为供应商上传、SQE 经 screen flow 核验）
export const QualityPermissionSet = {
  name: 'srm_quality',
  label: 'SRM 质量',
  objects: {
    srm_supplier: { ...read, allowEdit: true },
    srm_supplier_certificate: write,
    srm_supplier_application: read,
    // 交付记录：每月导入 ERP 收货与检验结果，没有质量系统时逐条录入（02 §4.6，03 §8）
    srm_delivery_record: write,
    // 整改单：手工新建（客户投诉、制程等），v0.6 前代供应商填写 8D 回复、推进状态、登记索赔（03 §8）
    srm_quality_issue: write,
    // 供应商审核：安排准入、专项审核，执行年度计划，录入结论与问题项（FR-607）
    srm_supplier_audit: write,
    srm_supplier_audit_finding: write,
    // 登记与处理风险事件（04 §2.3，v0.5）：资质、质量类风险由 SQE 跟进
    srm_risk_event: write,
  },
  fields: {
    ...supplierFieldsReadOnly,
    // 计划年度由 srm_audit_plan_generate 写入，问题项的整改单由「转整改单」回填
    'srm_supplier_audit.plan_year': flowOwned,
    'srm_supplier_audit_finding.quality_issue': flowOwned,
    'srm_supplier_certificate.status': flowOwned,
    'srm_supplier_certificate.legacy_imported': flowOwned,
    // 逾期标志由 srm_scar_overdue_sweep 维护
    'srm_quality_issue.is_overdue': flowOwned,
  },
};

// IQC 检验员：没有质量系统的客户由检验员逐条录入、更正交付记录（04 §2.2，02 §4.6）
export const IqcPermissionSet = {
  name: 'srm_iqc',
  label: 'SRM 来料检验',
  objects: {
    srm_delivery_record: write,
  },
};

// 管理层：全部只读；审批由 flow 授予，不需要写权限
export const ExecutivePermissionSet = {
  name: 'srm_executive',
  label: 'SRM 管理层',
  objects: {
    srm_category: read,
    srm_plant: read,
    srm_material: read,
    srm_supplier: read,
    srm_supplier_contact: read,
    srm_supplier_certificate: read,
    srm_supplier_category: read,
    srm_supplier_application: read,
    srm_supplier_change_request: read,
    srm_contract: read,
    srm_contract_line: read,
    srm_supplier_disposition: read,
    srm_delivery_record: read,
    srm_quality_issue: read,
    srm_supplier_audit: read,
    srm_supplier_audit_finding: read,
    srm_risk_event: read,
    srm_kpi: read,
    srm_performance_review: read,
    srm_performance_score: read,
  },
};

// 绩效管理（采购总监）：维护绩效指标库与权重（FR-701，04 §2.2）。不放进 srm_executive，否则总经理也能改指标；
// 改别人建的指标由共享规则 srm_kpi_director_edit 放行；删除只给 srm_admin，不再使用的指标停用
export const PerformancePermissionSet = {
  name: 'srm_performance',
  label: 'SRM 绩效管理',
  objects: {
    srm_kpi: write,
  },
};

const qualityIssueFieldsReadOnly = Object.fromEntries(Object.keys(QualityIssue.fields).map((field) => [`srm_quality_issue.${field}`, readOnly]));

// 财务（应付会计）：供应商档案与银行账户只读，银行账号完整可读（BR-20）；
// 核验只经「核验银行账户」screen flow（srm_bank_verify），不直接改记录
export const FinancePermissionSet = {
  name: 'srm_finance',
  label: 'SRM 财务',
  objects: {
    srm_supplier: read,
    srm_supplier_contact: read,
    srm_supplier_certificate: read,
    srm_supplier_bank_account: read,
    // 银行账户变更的第 2 级审批（BR-11）；审批权由 flow 授予
    srm_supplier_change_request: read,
    srm_contract: read,
    srm_contract_line: read,
    // 整改单只能改索赔状态：在 ERP 扣款后把「供应商已接受」的索赔标记为「已扣款」（03 §8 第 6 步）；
    // 改别人建的整改单靠共享规则 srm_quality_issue_edit_ap_accountant，其余字段 FLS 只读
    srm_quality_issue: { ...read, allowEdit: true },
  },
  systemPermissions: ['srm_view_bank_account_no'],
  fields: {
    ...qualityIssueFieldsReadOnly,
    'srm_quality_issue.claim_status': { readable: true, editable: true },
  },
};

// 管理员能删考评单要 modifyAllRecords，它连修改一起放开（objectstack#25470）：考评单字段对管理员一律只读
const reviewFieldsReadOnly = Object.fromEntries(Object.keys(PerformanceReview.fields).map((field) => [`srm_performance_review.${field}`, readOnly]));

// 系统管理员：维护品类与工厂等配置，执行物料导入和存量供应商、联系人、证书导入（04 §2.2）
export const AdminPermissionSet = {
  name: 'srm_admin',
  label: 'SRM 系统管理员',
  objects: {
    srm_category: { ...write, allowDelete: true },
    srm_plant: { ...write, allowDelete: true },
    // 删别人导入的物料要 modifyAllRecords，它同时放开修改（objectstack#25470），管理员本来就能改物料
    srm_material: { ...write, allowDelete: true, modifyAllRecords: true },
    srm_supplier: write,
    srm_supplier_contact: write,
    srm_supplier_certificate: write,
    // 删除只给系统管理员（04 §2.3）：导错的交付记录删掉后由 SQE 重导。删别人导入的记录要 modifyAllRecords，
    // 平台的 modifyAllRecords 同时放开了修改（objectstack#25470），管理员因此也能改交付记录
    srm_delivery_record: { ...read, allowDelete: true, modifyAllRecords: true },
    // 指标库的配置与清理（04 §2.2）；删除自己没建的指标要 modifyAllRecords，同上
    srm_kpi: { ...write, allowDelete: true, modifyAllRecords: true },
    // 删除错误生成的考评单（评分明细随之删除）后可补跑生成；删系统生成的记录要 modifyAllRecords，同交付记录
    srm_performance_review: { ...read, allowDelete: true, modifyAllRecords: true },
    srm_performance_score: { ...read, allowDelete: true },
  },
  fields: {
    'srm_supplier.status': flowOwned,
    'srm_supplier.qualification_alert': flowOwned,
    ...agreementFlags,
    'srm_supplier_certificate.status': flowOwned,
    ...reviewFieldsReadOnly,
  },
};

// 法务：合同与明细读改（草稿期间改条款；提交后合同只读），审批由 flow 授予（04 §2.2）
export const LegalPermissionSet = {
  name: 'srm_legal',
  label: 'SRM 法务',
  objects: {
    srm_contract: { ...read, allowEdit: true },
    srm_contract_line: { ...read, allowEdit: true },
  },
};

// 内控 / 审计：全部 SRM 对象只读（04 §2.2）。不授予 srm_view_bank_account_no，银行账号只看到后 4 位，
// 也就导不出完整账号；报价对象上线后同样受封标 RLS 约束（ADR-0004）
export const AuditorPermissionSet = {
  name: 'srm_auditor',
  label: 'SRM 内控审计',
  objects: {
    srm_category: read,
    srm_plant: read,
    srm_material: read,
    srm_supplier: read,
    srm_supplier_contact: read,
    srm_supplier_certificate: read,
    srm_supplier_category: read,
    srm_supplier_bank_account: read,
    srm_supplier_application: read,
    srm_supplier_change_request: read,
    srm_contract: read,
    srm_contract_line: read,
    srm_supplier_disposition: read,
    srm_delivery_record: read,
    srm_quality_issue: read,
    srm_supplier_audit: read,
    srm_supplier_audit_finding: read,
    srm_risk_event: read,
    srm_kpi: read,
    srm_performance_review: read,
    srm_performance_score: read,
  },
};

export const SrmPermissionSets = [
  InternalBasePermissionSet,
  BuyerPermissionSet,
  SupplierAdminPermissionSet,
  QualityPermissionSet,
  IqcPermissionSet,
  ExecutivePermissionSet,
  PerformancePermissionSet,
  FinancePermissionSet,
  LegalPermissionSet,
  AuditorPermissionSet,
  AdminPermissionSet,
];
