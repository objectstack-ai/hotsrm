import type { TranslationData } from '@objectstack/spec/system';

// 源码里的标签是中文；英文词条覆盖全部对象、字段、选项与导航（ADR-0007）。
export const en: TranslationData = {
  objects: {
    srm_category: {
      label: 'Purchasing Category',
      pluralLabel: 'Purchasing Categories',
      fields: {
        code: { label: 'Category Code' },
        name: { label: 'Category Name' },
        parent: { label: 'Parent Category' },
        category_manager: { label: 'Category Manager' },
        sqe: { label: 'SQE' },
        is_direct: { label: 'Direct Material' },
        risk_class: {
          label: 'Risk Class',
          options: { high: 'High', medium: 'Medium', low: 'Low' },
        },
      },
      _views: { default: { label: 'All Categories' } },
    },
  },
  apps: {
    srm_workbench: {
      label: 'SRM Workbench',
      navigation: {
        group_master_data: { label: 'Master Data' },
        nav_category: { label: 'Purchasing Categories' },
      },
    },
  },
};
