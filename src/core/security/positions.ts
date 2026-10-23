// 内部岗位（04 §2.1）的子集：只列已上线流程用到的岗位，其余随对应版本加入。
// 挂载的权限集同样是子集：`srm_buyer`、`srm_sourcing` 等权限集随其对象上线后补挂。
export const SrmPositions = [
  { name: 'srm_procurement_director', label: '采购总监', permissionSets: ['srm_internal_base', 'srm_executive'] },
  { name: 'srm_category_manager', label: '品类经理', permissionSets: ['srm_internal_base', 'srm_supplier_admin'] },
  { name: 'srm_buyer', label: '采购员', permissionSets: ['srm_internal_base'] },
  { name: 'srm_buyer_lead', label: '采购主管', permissionSets: ['srm_internal_base', 'srm_supplier_admin'] },
  { name: 'srm_sqe', label: 'SQE', permissionSets: ['srm_internal_base', 'srm_quality'] },
  { name: 'srm_ap_accountant', label: '应付会计', permissionSets: ['srm_internal_base', 'srm_finance'] },
  { name: 'srm_admin', label: 'SRM 系统管理员', permissionSets: ['srm_internal_base', 'srm_admin'] },
];
