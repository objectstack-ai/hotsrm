import { ObjectSchema, Field } from '@objectstack/spec/data';

// 工厂 / 收货地点（02 §4.1）。ERP 集成之前用种子数据或导入维护。
export const Plant = ObjectSchema.create({
  name: 'srm_plant',
  label: '工厂',
  pluralLabel: '工厂',
  icon: 'warehouse',
  sharingModel: 'public_read',

  fieldGroups: [
    { key: 'basic', label: '基本信息', icon: 'warehouse' },
  ],

  fields: {
    code: Field.text({ label: '工厂编码', group: 'basic', required: true, unique: true, maxLength: 40 }),
    name: Field.text({ label: '工厂名称', group: 'basic', required: true, searchable: true, maxLength: 100 }),
    erp_plant_id: Field.text({ label: 'ERP 工厂编号', group: 'basic', unique: true, maxLength: 40 }),
    legal_entity: Field.text({ label: '所属法人', group: 'basic', maxLength: 200 }),
    address: Field.address({ label: '地址', group: 'basic' }),
  },
});
