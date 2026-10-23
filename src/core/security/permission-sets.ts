// 内部权限集（04 §2.2）的 v0.1 子集。一律不设 isDefault（AGENTS.md 红线 2）。
// 状态类字段（供应商状态、资质异常、证书状态）只由 flow 写入，权限集里一律只读。

const read = { allowCreate: false, allowRead: true, allowEdit: false, allowDelete: false, viewAllRecords: true, modifyAllRecords: false };
const write = { allowCreate: true, allowRead: true, allowEdit: true, allowDelete: false, viewAllRecords: true, modifyAllRecords: false };
// 供应商主数据在集团内共享（04 §5）：维护者能改所有供应商，不只是自己建的
const writeAll = { ...write, modifyAllRecords: true };
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
  },
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
  },
  fields: {
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
    srm_supplier: writeAll,
    srm_supplier_contact: { ...write, allowDelete: true },
    srm_supplier_certificate: write,
    srm_supplier_category: write,
    srm_supplier_application: write,
    // 发起信息变更；银行账户变更要填完整账号，只有持 srm_view_bank_account_no 的岗位能发起（BR-20）
    srm_supplier_change_request: write,
    // 新建账户后为「待核验」并锁定；核验只经 srm_bank_verify，已有账户的修改走信息变更单（v0.2 M4）
    srm_supplier_bank_account: write,
  },
  // 银行账号完整可读（BR-20，04 §4.2）
  systemPermissions: ['srm_view_bank_account_no'],
  fields: {
    'srm_supplier.status': flowOwned,
    'srm_supplier.qualification_alert': flowOwned,
    'srm_supplier_certificate.status': flowOwned,
    'srm_supplier_category.status': flowOwned,
    'srm_supplier_category.approved_date': flowOwned,
    ...importOwned,
  },
};

// SQE：v0.1 由 SQE 维护证书（门户版本改为供应商上传、SQE 经 screen flow 核验）
export const QualityPermissionSet = {
  name: 'srm_quality',
  label: 'SRM 质量',
  objects: {
    srm_supplier: { ...read, allowEdit: true },
    srm_supplier_certificate: write,
    srm_supplier_application: read,
  },
  fields: {
    'srm_supplier.status': flowOwned,
    'srm_supplier.qualification_alert': flowOwned,
    'srm_supplier_certificate.status': flowOwned,
    'srm_supplier.legacy_reviewed': flowOwned,
    ...importOwned,
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
  },
};

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
  },
  systemPermissions: ['srm_view_bank_account_no'],
};

// 系统管理员：维护品类与工厂等配置，执行物料导入和存量供应商、联系人、证书导入（04 §2.2）
export const AdminPermissionSet = {
  name: 'srm_admin',
  label: 'SRM 系统管理员',
  objects: {
    srm_category: { ...write, allowDelete: true },
    srm_plant: { ...write, allowDelete: true },
    srm_material: { ...write, allowDelete: true },
    srm_supplier: writeAll,
    srm_supplier_contact: write,
    srm_supplier_certificate: write,
  },
  fields: {
    'srm_supplier.status': flowOwned,
    'srm_supplier.qualification_alert': flowOwned,
    'srm_supplier_certificate.status': flowOwned,
  },
};

export const SrmPermissionSets = [
  InternalBasePermissionSet,
  BuyerPermissionSet,
  SupplierAdminPermissionSet,
  QualityPermissionSet,
  ExecutivePermissionSet,
  FinancePermissionSet,
  AdminPermissionSet,
];
