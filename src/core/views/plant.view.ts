import { defineView } from '@objectstack/spec';

export const PlantViews = defineView({
  list: {
    label: '全部工厂',
    type: 'grid',
    data: { provider: 'object', object: 'srm_plant' },
    columns: [{ field: 'code' }, { field: 'name' }, { field: 'legal_entity' }, { field: 'erp_plant_id' }],
    sort: [{ field: 'code', order: 'asc' }],
  },
});
