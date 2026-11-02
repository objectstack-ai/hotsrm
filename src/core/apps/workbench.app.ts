import { App } from '@objectstack/spec/ui';

// SRM 应用：内部工作台与供应商门户（05 §1）。导航按分组组织，扩展包往分组里挂菜单（ADR-0002）。
// 平台规定一个应用包只有一个应用（objectstack ADR-0019 D3），所以门户不是第二个应用，而是本应用里只对持门户能力
// srm_portal_access 的用户显示的一组导航（门户权限集授予）；内部分组反过来只对持 srm_internal_access 的内部员工显示
// （v0.6 出口验收：门户用户原先也看到「处置单」「门户邀请」等内部菜单，点进去是「无权访问」）。这只是体验：门户用户
// 能看到哪些行由门户 RLS 决定（ADR-0010），直接打开内部对象的地址也只看到本公司的数据。
export const Workbench = App.create({
  name: 'srm_workbench',
  label: 'SRM 工作台',
  icon: 'handshake',
  navigation: [
    // 供应商门户（05 §1.2，v0.6）：首页是一组待办列表（01 §5.10），点进去就是要处理的那条记录；询价与报价随 v0.7 加入
    {
      id: 'group_portal',
      type: 'group',
      label: '供应商门户',
      icon: 'store',
      expanded: true,
      requiredPermissions: ['srm_portal_access'],
      children: [
        {
          id: 'portal_home',
          type: 'group',
          label: '首页',
          icon: 'house',
          expanded: true,
          children: [
            { id: 'portal_nav_todo_issues', type: 'object', objectName: 'srm_quality_issue', viewName: 'portal_todo', label: '待我处理的整改单', icon: 'clipboard-x' },
            { id: 'portal_nav_todo_certificates', type: 'object', objectName: 'srm_supplier_certificate', viewName: 'expiring', label: '即将到期的证书', icon: 'badge-alert' },
            { id: 'portal_nav_todo_applications', type: 'object', objectName: 'srm_supplier_application', viewName: 'in_progress', label: '准入申请进度', icon: 'clipboard-check' },
            { id: 'portal_nav_latest_reviews', type: 'object', objectName: 'srm_performance_review', label: '最新绩效', icon: 'award' },
          ],
        },
        {
          id: 'portal_company',
          type: 'group',
          label: '公司资料',
          icon: 'building',
          expanded: true,
          children: [
            { id: 'portal_nav_profile', type: 'object', objectName: 'srm_supplier', label: '本公司档案', icon: 'factory' },
            { id: 'portal_nav_contacts', type: 'object', objectName: 'srm_supplier_contact', label: '联系人', icon: 'contact' },
            { id: 'portal_nav_certificates', type: 'object', objectName: 'srm_supplier_certificate', label: '资质证书', icon: 'badge-check' },
            { id: 'portal_nav_bank_accounts', type: 'object', objectName: 'srm_supplier_bank_account', label: '银行账户', icon: 'landmark' },
            { id: 'portal_nav_change_requests', type: 'object', objectName: 'srm_supplier_change_request', label: '变更申请', icon: 'file-pen' },
            { id: 'portal_nav_applications', type: 'object', objectName: 'srm_supplier_application', label: '准入申请', icon: 'clipboard-check' },
          ],
        },
        {
          id: 'portal_quality',
          type: 'group',
          label: '质量',
          icon: 'shield-check',
          children: [
            { id: 'portal_nav_quality_issues', type: 'object', objectName: 'srm_quality_issue', label: '整改单', icon: 'clipboard-x' },
            { id: 'portal_nav_delivery_records', type: 'object', objectName: 'srm_delivery_record', label: '交付结果', icon: 'truck' },
          ],
        },
        {
          id: 'portal_performance',
          type: 'group',
          label: '绩效',
          icon: 'gauge',
          children: [
            { id: 'portal_nav_reviews', type: 'object', objectName: 'srm_performance_review', label: '历次考评结果', icon: 'award' },
          ],
        },
      ],
    },
    {
      id: 'group_supplier',
      type: 'group',
      requiredPermissions: ['srm_internal_access'],
      label: '供应商',
      icon: 'factory',
      expanded: true,
      children: [
        { id: 'nav_supplier', type: 'object', objectName: 'srm_supplier', label: '供应商', icon: 'factory' },
        { id: 'nav_application', type: 'object', objectName: 'srm_supplier_application', label: '准入申请', icon: 'clipboard-check' },
        { id: 'nav_certificate', type: 'object', objectName: 'srm_supplier_certificate', label: '资质证书', icon: 'badge-check' },
        { id: 'nav_bank_account', type: 'object', objectName: 'srm_supplier_bank_account', label: '银行账户', icon: 'landmark' },
        { id: 'nav_change_request', type: 'object', objectName: 'srm_supplier_change_request', label: '变更单', icon: 'file-pen' },
        { id: 'nav_disposition', type: 'object', objectName: 'srm_supplier_disposition', label: '处置单', icon: 'ban' },
        { id: 'nav_invitation', type: 'object', objectName: 'srm_supplier_invitation', label: '门户邀请', icon: 'mail-plus' },
        { id: 'nav_portal_accounts', type: 'object', objectName: 'srm_supplier_contact', viewName: 'portal_accounts', label: '门户账号', icon: 'key-round' },
      ],
    },
    {
      id: 'group_contract',
      type: 'group',
      requiredPermissions: ['srm_internal_access'],
      label: '合同',
      icon: 'file-signature',
      children: [
        { id: 'nav_contract', type: 'object', objectName: 'srm_contract', label: '合同', icon: 'file-signature' },
      ],
    },
    {
      id: 'group_quality',
      type: 'group',
      requiredPermissions: ['srm_internal_access'],
      label: '质量',
      icon: 'shield-check',
      children: [
        { id: 'nav_delivery_record', type: 'object', objectName: 'srm_delivery_record', label: '交付记录', icon: 'truck' },
        { id: 'nav_quality_issue', type: 'object', objectName: 'srm_quality_issue', label: '整改单', icon: 'clipboard-x' },
        { id: 'nav_supplier_audit', type: 'object', objectName: 'srm_supplier_audit', label: '供应商审核', icon: 'clipboard-list' },
      ],
    },
    {
      id: 'group_performance',
      type: 'group',
      requiredPermissions: ['srm_internal_access'],
      label: '绩效与风险',
      icon: 'gauge',
      children: [
        { id: 'nav_kpi', type: 'object', objectName: 'srm_kpi', label: '绩效指标', icon: 'gauge' },
        { id: 'nav_performance_review', type: 'object', objectName: 'srm_performance_review', label: '考评单', icon: 'award' },
        { id: 'nav_my_scores', type: 'object', objectName: 'srm_performance_score', viewName: 'mine', label: '待我评分', icon: 'pencil' },
        { id: 'nav_risk_event', type: 'object', objectName: 'srm_risk_event', label: '风险事件', icon: 'siren' },
      ],
    },
    {
      id: 'group_analytics',
      type: 'group',
      requiredPermissions: ['srm_internal_access'],
      label: '分析',
      icon: 'chart-column',
      children: [
        { id: 'nav_delivery_dashboard', type: 'dashboard', dashboardName: 'srm_delivery_dashboard', label: '交付看板', icon: 'truck' },
        { id: 'nav_quality_dashboard', type: 'dashboard', dashboardName: 'srm_quality_dashboard', label: '质量看板', icon: 'shield-check' },
        { id: 'nav_supplier_dashboard', type: 'dashboard', dashboardName: 'srm_supplier_dashboard', label: '供应商看板', icon: 'factory' },
        { id: 'nav_delivery_scorecard', type: 'report', reportName: 'srm_delivery_scorecard', label: '供应商交付与质量', icon: 'table' },
      ],
    },
    {
      id: 'group_master_data',
      type: 'group',
      requiredPermissions: ['srm_internal_access'],
      label: '基础数据',
      icon: 'database',
      children: [
        { id: 'nav_category', type: 'object', objectName: 'srm_category', label: '采购品类', icon: 'folder-tree' },
        { id: 'nav_material', type: 'object', objectName: 'srm_material', label: '物料', icon: 'package' },
        { id: 'nav_plant', type: 'object', objectName: 'srm_plant', label: '工厂', icon: 'warehouse' },
      ],
    },
  ],
});
