// 内部岗位（04 §2.1）的子集：只列已上线和本版本流程用到的岗位，其余随对应版本加入。
// 挂载的权限集同样是子集：`srm_sourcing` 等权限集随其对象上线后补挂。
// 岗位与权限集的标签暂时只有中文：翻译包还没有岗位、权限集的词条（objectstack#25652），平台补上后加英文。
export const SrmPositions = [
  // 采购总监另挂 srm_performance：维护绩效指标库（FR-701，v0.5）
  { name: 'srm_procurement_director', label: '采购总监', permissionSets: ['srm_internal_base', 'srm_buyer', 'srm_executive', 'srm_performance'] },
  { name: 'srm_category_manager', label: '品类经理', permissionSets: ['srm_internal_base', 'srm_supplier_admin'] },
  { name: 'srm_buyer', label: '采购员', permissionSets: ['srm_internal_base', 'srm_buyer'] },
  { name: 'srm_buyer_lead', label: '采购主管', permissionSets: ['srm_internal_base', 'srm_buyer', 'srm_supplier_admin'] },
  { name: 'srm_sqe', label: 'SQE', permissionSets: ['srm_internal_base', 'srm_quality'] },
  // 质量经理：SQE 主管，权限同 SQE；A 类 / 高风险准入的会签由 flow 授予（03 §12），整改逾期升级随 v0.4 Q2 加入
  { name: 'srm_quality_manager', label: '质量经理', permissionSets: ['srm_internal_base', 'srm_quality'] },
  { name: 'srm_iqc_inspector', label: 'IQC 检验员', permissionSets: ['srm_internal_base', 'srm_iqc'] },
  { name: 'srm_ap_accountant', label: '应付会计', permissionSets: ['srm_internal_base', 'srm_finance'] },
  { name: 'srm_legal_counsel', label: '法务', permissionSets: ['srm_internal_base', 'srm_legal'] },
  { name: 'srm_general_manager', label: '总经理', permissionSets: ['srm_internal_base', 'srm_executive'] },
  // 内控 / 监标：只挂 srm_auditor（已含全部 SRM 对象只读）；淘汰、黑名单的会签审批由 flow 授予
  { name: 'srm_procurement_compliance', label: '内控 / 监标', permissionSets: ['srm_auditor'] },
  { name: 'srm_admin', label: 'SRM 系统管理员', permissionSets: ['srm_internal_base', 'srm_admin'] },
];
