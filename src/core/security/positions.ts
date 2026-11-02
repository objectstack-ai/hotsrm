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
  // 需求部门评分人（v0.5）：只读，绩效评分只经「提交评分」screen flow；指派到品类的 evaluator 字段上（03 §10 第 3 步）
  { name: 'srm_evaluator', label: '评分人', permissionSets: ['srm_internal_base'] },
  { name: 'srm_general_manager', label: '总经理', permissionSets: ['srm_internal_base', 'srm_executive'] },
  // 内控 / 监标：只挂 srm_auditor（已含全部 SRM 对象只读）；淘汰、黑名单的会签审批由 flow 授予
  { name: 'srm_procurement_compliance', label: '内控 / 监标', permissionSets: ['srm_auditor'] },
  { name: 'srm_admin', label: 'SRM 系统管理员', permissionSets: ['srm_internal_base', 'srm_admin'] },
  // 门户岗位（v0.6，ADR-0010）：全体门户用户共用这两个静态岗位，不再每家供应商建一个。门户用户按组织角色 external
  // 邀请，任命到 srm_portal_user；本公司门户管理员再任命到 srm_portal_admin。能看哪家供应商只由联系人上的
  // portal_user 决定（成员键 portal_supplier_ids），内部员工不任命到这两个岗位
  { name: 'srm_portal_user', label: '供应商门户用户', permissionSets: ['srm_portal_supplier'] },
  { name: 'srm_portal_admin', label: '供应商门户管理员', permissionSets: ['srm_portal_admin'] },
];

// 门户岗位：共享规则只把 private 对象放给 srm_portal_user，行范围再由门户 RLS 限定到本公司
export const SrmPortalPositions = ['srm_portal_user', 'srm_portal_admin'];
