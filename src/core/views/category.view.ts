import { defineView } from '@objectstack/spec';

export const CategoryViews = defineView({
  list: {
    label: '全部品类',
    type: 'grid',
    data: { provider: 'object', object: 'srm_category' },
    columns: [
      { field: 'code' },
      { field: 'name' },
      { field: 'parent' },
      { field: 'material_class' },
      { field: 'risk_class' },
      { field: 'is_direct' },
      { field: 'category_manager' },
      { field: 'sqe' },
    ],
    sort: [{ field: 'code', order: 'asc' }],
  },
});
