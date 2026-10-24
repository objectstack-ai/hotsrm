import { App } from '@objectstack/spec/ui';

// 内部工作台。导航按分组组织，扩展包往分组里挂菜单（ADR-0002）。
export const Workbench = App.create({
  name: 'srm_workbench',
  label: 'SRM 工作台',
  icon: 'handshake',
  navigation: [
    {
      id: 'group_supplier',
      type: 'group',
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
      ],
    },
    {
      id: 'group_contract',
      type: 'group',
      label: '合同',
      icon: 'file-signature',
      children: [
        { id: 'nav_contract', type: 'object', objectName: 'srm_contract', label: '合同', icon: 'file-signature' },
      ],
    },
    {
      id: 'group_quality',
      type: 'group',
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
      label: '绩效与风险',
      icon: 'gauge',
      children: [
        { id: 'nav_kpi', type: 'object', objectName: 'srm_kpi', label: '绩效指标', icon: 'gauge' },
        { id: 'nav_risk_event', type: 'object', objectName: 'srm_risk_event', label: '风险事件', icon: 'siren' },
      ],
    },
    {
      id: 'group_analytics',
      type: 'group',
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
