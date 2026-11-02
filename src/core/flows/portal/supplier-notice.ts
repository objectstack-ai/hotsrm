import type * as Automation from '@objectstack/spec/automation';

// 供应商侧通知（05 §5，v0.6 U6）的公共节点。门户用户是组织成员（组织角色 external），notify 能直接发给他们；收件人一律
// 从「这条记录所属供应商」的联系人名册里取（ADR-0010 红线 2）：
// - 名册条件与成员键 portal_supplier_ids 相同（在职、portal_user 有值），供应商取触发记录自己的 supplier，不接受外部传入；
// - 通知内容走邮件模板（src/core/notifications），模板数据只取触发记录和它所属供应商自己的字段；
// - 邮件和站内信同一份模板，按收件人语言出中文或英文；正文只写单号、事件和「登录门户查看」，不放金额、账号等敏感内容（05 §5、R5）。
// 内部经办人的通知不经这里，保持原样（没开通门户的供应商由经办人转告，v0.5 行为不变）。
const c = (source: string) => ({ dialect: 'cel' as const, source });

export const ROSTER = 'roster';

// 读取供应商的门户名册：supplier 是一段求值为供应商 id 的 CEL（触发记录上的 supplier）
export const loadRoster = (supplier: string, id = 'load_roster'): Automation.FlowNode => ({
  id,
  type: 'get_record',
  label: '读取供应商的门户名册',
  config: {
    objectName: 'srm_supplier_contact',
    filter: { supplier: c(supplier), active: true, portal_user: { $ne: null } },
    fields: ['id', 'supplier', 'portal_user', 'contact_function'],
    limit: 200,
    outputVariable: ROSTER,
  },
});

const hasFunction = (fn: string) => `has(r.contact_function) && r.contact_function != null && '${fn}' in r.contact_function`;

// 名册上某职能联系人的门户账号；没有这个职能的门户联系人时发给主账号（admin）联系人
export const byFunction = (fn: string) =>
  fn === 'admin'
    ? `${ROSTER}.filter(r, ${hasFunction('admin')}).map(r, r.portal_user)`
    : `${ROSTER}.exists(r, ${hasFunction(fn)}) ? ${ROSTER}.filter(r, ${hasFunction(fn)}).map(r, r.portal_user)`
      + ` : ${ROSTER}.filter(r, ${hasFunction('admin')}).map(r, r.portal_user)`;

// 名册上任一所列职能的联系人的门户账号（每人一次）
export const byAnyFunction = (fns: string[]) => `${ROSTER}.filter(r, ${fns.map((fn) => `(${hasFunction(fn)})`).join(' || ')}).map(r, r.portal_user)`;

// 名册上的某一位联系人（如受邀联系人）的门户账号
export const rosterContact = (contact: string) => `${ROSTER}.filter(r, r.id == ${contact}).map(r, r.portal_user)`;

// 门户管理员：名册上的门户账号中任命了 srm_portal_admin 的（银行账户、变更单由门户管理员维护，04 §3.2）
export const PORTAL_ADMINS = 'portalAdmins';
export const loadPortalAdmins = (id = 'load_portal_admins'): Automation.FlowNode => ({
  id,
  type: 'get_record',
  label: '读取名册上的门户管理员',
  config: {
    objectName: 'sys_user_position',
    filter: { position: 'srm_portal_admin', user_id: { $in: c(`${ROSTER}.map(r, r.portal_user)`) } },
    fields: ['user_id'],
    limit: 200,
    outputVariable: PORTAL_ADMINS,
  },
});
export const portalAdmins = `${PORTAL_ADMINS}.map(p, p.user_id)`;

// 这个用户是名册上的门户账号吗（内部经办人的通知据此跳过门户用户，避免同一件事收到两条）
export const onRoster = (user: string) => `${ROSTER}.exists(r, r.portal_user == ${user})`;

// 发给供应商：收件人、模板名、模板数据（每项一段 CEL）、链接到的记录。没有可发的人或投递出错不影响业务写入：包在 try_catch 里
export const notifySupplier = (
  id: string,
  label: string,
  config: { recipients: string; template: string; data: Record<string, string>; sourceObject: string; sourceId: string },
): Automation.FlowNode =>
  ({
    id: `${id}_guard`,
    type: 'try_catch',
    label,
    config: {
      try: {
        nodes: [
          {
            id,
            type: 'notify',
            label,
            config: {
              recipients: c(config.recipients),
              template: config.template,
              templateData: Object.fromEntries(Object.entries(config.data).map(([k, v]) => [k, c(v)])),
              channels: ['inbox', 'email'],
              topic: 'srm_supplier',
              sourceObject: config.sourceObject,
              sourceId: c(config.sourceId),
            },
          },
        ],
      },
      catch: { nodes: [{ id: `${id}_skip`, type: 'assignment', label: '跳过通知' }] },
    },
  }) as Automation.FlowNode;

// 模板里常用的「可能为空的文本字段」
export const text = (path: string, fallback = '-') => {
  const [obj, field] = [path.slice(0, path.lastIndexOf('.')), path.slice(path.lastIndexOf('.') + 1)];
  return `has(${obj}.${field}) && ${path} != null ? string(${path}) : '${fallback}'`;
};

// 读取触发记录所属供应商的名称（模板里的「贵司」）
export const VENDOR = 'vendor';
export const loadVendor = (supplier: string, id = 'load_vendor'): Automation.FlowNode => ({
  id,
  type: 'get_record',
  label: '读取供应商名称',
  config: { objectName: 'srm_supplier', filter: { id: c(supplier) }, fields: ['id', 'name'], outputVariable: VENDOR },
});
export const vendorName = `${VENDOR} != null ? ${VENDOR}.name : '-'`;
export const pathOf = (object: string, id: string) => `'/${object}/' + ${id}`;
