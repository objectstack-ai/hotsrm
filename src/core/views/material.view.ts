import { defineView } from '@objectstack/spec';

const data = { provider: 'object' as const, object: 'srm_material' };

export const MaterialViews = defineView({
  list: {
    label: '全部物料',
    type: 'grid',
    data,
    columns: [
      { field: 'material_code' },
      { field: 'name' },
      { field: 'specification' },
      { field: 'uom' },
      { field: 'category' },
      { field: 'active' },
    ],
    sort: [{ field: 'material_code', order: 'asc' }],
  },

  listViews: {
    uncategorized: {
      label: '未关联品类',
      type: 'grid',
      data,
      columns: [{ field: 'material_code' }, { field: 'name' }, { field: 'specification' }, { field: 'uom' }],
      filter: [{ field: 'category', operator: 'is_null' }],
    },
  },
});
