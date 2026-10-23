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
        { id: 'nav_certificate', type: 'object', objectName: 'srm_supplier_certificate', label: '资质证书', icon: 'badge-check' },
      ],
    },
    {
      id: 'group_master_data',
      type: 'group',
      label: '基础数据',
      icon: 'database',
      children: [
        { id: 'nav_category', type: 'object', objectName: 'srm_category', label: '采购品类', icon: 'folder-tree' },
        { id: 'nav_plant', type: 'object', objectName: 'srm_plant', label: '工厂', icon: 'warehouse' },
      ],
    },
  ],
});
