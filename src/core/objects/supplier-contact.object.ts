import { P } from '@objectstack/spec';
import { ObjectSchema, Field } from '@objectstack/spec/data';

// 供应商联系人（02 §4.1）。也是门户的成员名册（ADR-0010）：在职联系人上的 portal_user 决定这个门户账号属于哪家供应商。
export const SupplierContact = ObjectSchema.create({
  name: 'srm_supplier_contact',
  label: '供应商联系人',
  pluralLabel: '供应商联系人',
  icon: 'contact',
  sharingModel: 'controlled_by_parent',

  fieldGroups: [
    { key: 'contact', label: '联系人信息', icon: 'contact' },
  ],

  fields: {
    supplier: Field.masterDetail('srm_supplier', { label: '供应商', required: true, deleteBehavior: 'cascade' }),
    name: Field.text({ label: '姓名', group: 'contact', required: true, searchable: true, maxLength: 50 }),
    contact_function: {
      type: 'multiselect',
      label: '职能',
      group: 'contact',
      options: [
        { label: '主账号', value: 'admin' },
        { label: '商务', value: 'sales' },
        { label: '物流', value: 'logistics' },
        { label: '质量', value: 'quality' },
        { label: '财务', value: 'finance' },
      ],
    },
    mobile: Field.phone({ label: '手机', group: 'contact' }),
    email: Field.email({ label: '邮箱', group: 'contact', required: true }),
    is_primary: Field.boolean({ label: '主联系人', group: 'contact', defaultValue: false }),
    active: Field.boolean({ label: '有效', group: 'contact', defaultValue: true }),
    // 门户账号（v0.6）：只由「开通门户」等 flow 写入，任何人在界面和 REST 上都改不了。写了它就等于把这家供应商的
    // 门户数据授给这个用户，所以不能交给任何岗位直接编辑（ADR-0010）
    portal_user: Field.user({ label: '门户账号', group: 'contact', readonly: true }),
  },

  // 门户隔离的成员键（ADR-0010，平台 ObjectSchema.membershipKeys）：current_user.portal_supplier_ids 是当前用户作为
  // 在职联系人所属的供应商。平台每个请求以系统身份读一次本对象；取不到、超过上限或出错时，读这个键的策略一律不放行
  membershipKeys: {
    portal_supplier_ids: {
      userField: 'portal_user',
      valueField: 'supplier',
      filter: 'active == true',
      label: '门户所属供应商',
      description: '当前用户作为在职联系人的门户账号所属的供应商',
    },
  },

  // 每家供应商至多一位主联系人（02 §4.1）：这里只做守卫，拒绝第二位主联系人（含导入）；
  // 更换主联系人由「设为主联系人」screen flow 先清掉旧的再设新的。
  validations: [
    {
      name: 'single_primary_on_insert',
      type: 'script',
      severity: 'error',
      events: ['insert'],
      message: '该供应商已有主联系人，每家供应商至多一位',
      condition: P`record.is_primary == true && record.supplier.primary_contact_count > 0`,
    },
    {
      name: 'single_primary_on_update',
      type: 'script',
      severity: 'error',
      events: ['update'],
      message: '该供应商已有主联系人，每家供应商至多一位',
      condition: P`record.is_primary == true && previous.is_primary != true && record.supplier.primary_contact_count > 0`,
    },
  ],
});
