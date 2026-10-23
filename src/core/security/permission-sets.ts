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

// 内部员工的基础：读基础数据与供应商主数据
export const InternalBasePermissionSet = {
  name: 'srm_internal_base',
  label: 'SRM 内部基础',
  objects: {
    srm_category: read,
    srm_plant: read,
    srm_supplier: read,
    srm_supplier_contact: read,
    srm_supplier_certificate: read,
    srm_supplier_category: read,
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
  },
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
    srm_supplier: read,
    srm_supplier_contact: read,
    srm_supplier_certificate: read,
    srm_supplier_category: read,
    srm_supplier_application: read,
  },
};

// 系统管理员：维护品类与工厂等配置；导入存量供应商、联系人和证书（04 §2.2）
export const AdminPermissionSet = {
  name: 'srm_admin',
  label: 'SRM 系统管理员',
  objects: {
    srm_category: { ...write, allowDelete: true },
    srm_plant: { ...write, allowDelete: true },
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
  SupplierAdminPermissionSet,
  QualityPermissionSet,
  ExecutivePermissionSet,
  AdminPermissionSet,
];
