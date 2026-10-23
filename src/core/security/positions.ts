// 内部岗位（04 §2.1）的 v0.1 子集：只列 v0.1 流程用到的岗位，其余随对应版本加入。
export const SrmPositions = [
  { name: 'srm_procurement_director', label: '采购总监', permissionSets: ['srm_internal_base', 'srm_executive'] },
  { name: 'srm_category_manager', label: '品类经理', permissionSets: ['srm_internal_base', 'srm_supplier_admin'] },
  { name: 'srm_buyer', label: '采购员', permissionSets: ['srm_internal_base'] },
  { name: 'srm_sqe', label: 'SQE', permissionSets: ['srm_internal_base', 'srm_quality'] },
  { name: 'srm_admin', label: 'SRM 系统管理员', permissionSets: ['srm_internal_base', 'srm_admin'] },
];
