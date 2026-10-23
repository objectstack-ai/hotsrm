// 内部权限集（04 §2.2）的 v0.1 子集。一律不设 isDefault（AGENTS.md 红线 2）。
// 状态类字段（供应商状态、资质异常、证书状态）只由 flow 写入，权限集里一律只读。

const read = { allowCreate: false, allowRead: true, allowEdit: false, allowDelete: false, viewAllRecords: true, modifyAllRecords: false };
const write = { allowCreate: true, allowRead: true, allowEdit: true, allowDelete: false, viewAllRecords: true, modifyAllRecords: false };
const flowOwned = { readable: true, editable: false };
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
  },
};

// 采购员：物料是 ERP 的只读副本（ADR-0008），采购员只维护物料与品类的关联，不新建、不删除
export const BuyerPermissionSet = {
  name: 'srm_buyer',
  label: 'SRM 采购',
  objects: {
    srm_material: { ...read, allowEdit: true },
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
    srm_supplier: write,
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
  },
};

// 系统管理员：维护品类与工厂等配置，执行物料导入
export const AdminPermissionSet = {
  name: 'srm_admin',
  label: 'SRM 系统管理员',
  objects: {
    srm_category: { ...write, allowDelete: true },
    srm_plant: { ...write, allowDelete: true },
    srm_material: { ...write, allowDelete: true },
  },
};

export const SrmPermissionSets = [
  InternalBasePermissionSet,
  BuyerPermissionSet,
  SupplierAdminPermissionSet,
  QualityPermissionSet,
  ExecutivePermissionSet,
  AdminPermissionSet,
];
