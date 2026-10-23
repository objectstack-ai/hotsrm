import { App } from '@objectstack/spec/ui';

// 内部工作台。导航按分组组织，扩展包往分组里挂菜单（ADR-0002）。
export const Workbench = App.create({
  name: 'srm_workbench',
  label: 'SRM 工作台',
  icon: 'handshake',
  navigation: [
    {
      id: 'group_master_data',
      type: 'group',
      label: '基础数据',
      icon: 'database',
      expanded: true,
      children: [
        { id: 'nav_category', type: 'object', objectName: 'srm_category', label: '采购品类', icon: 'folder-tree' },
      ],
    },
  ],
});
