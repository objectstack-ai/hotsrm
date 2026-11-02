import { P, cel } from '@objectstack/spec';
import type * as Automation from '@objectstack/spec/automation';
import { ORG_ADMIN_ROLES } from './org-admins.js';

// 开通门户（04 §3.3 第 2 步，ADR-0010）：组织管理员已在成员页按邀请邮箱发出邀请（角色 external），对方注册并接受后，
// 在门户邀请上运行本 flow，选择已加入的用户：
// 1. 把用户任命到静态岗位 srm_portal_user，邀请上勾了「授予门户管理员」（附授权书，GL-10 6.3.1 c）时再任命到 srm_portal_admin；
// 2. 经子 flow srm_portal_roster_write 在联系人上写 portal_user，邀请置为「已开通」。写入后下一个请求起该用户只能看到本公司数据。
//
// 身份为什么分两段（07 §6.2 V2，U3 实测 2026-11-02）：
// - 任命是身份数据行，runAs: 'system' 的 flow 不得写（objectstack#25251）；runAs: 'user' 只有组织管理员启动时能写，
//   其他人启动被平台拒绝。所以本 flow 是 runAs: 'user'；
// - portal_user 是字段级只读（任何人都不能在界面或 REST 上写），runAs: 'user' 的写入被数据层剔除（节点结果只给警告、
//   写入照样算成功，平台既定行为，07 §6.3 PF19）；所以由 runAs: 'system' 的 autolaunched 子 flow 写。平台对任何调用者（含平台管理员）都拒绝直接启动系统身份的
//   autolaunched flow，子 flow 只能经本 flow 进入；
// - 本 flow 进门先查操作人的组织角色，不是 owner / admin 就结束：子 flow 以系统身份写名册，这道检查是名册写入前的
//   最后一道门（第一次开通时还有平台对任命的检查；已持有门户岗位的用户再开通到另一位联系人上时不再任命）。
// 选的用户必须是 external 成员（内部员工不进门户名册），且没有登记在任何联系人上：登记在两家时两家的数据都能看到，
// 平台没有「非空值唯一」的约束可以兜底（ADR-0010 后果）。
const PORTAL_USER = 'srm_portal_user';
const PORTAL_ADMIN = 'srm_portal_admin';
const c = (source: string) => ({ dialect: 'cel' as const, source });

const isAdmin = `operator != null`;
const open = `invite != null && invite.status == 'sent'`;
const ready = `contact != null && contact.active == true && !(has(contact.portal_user) && contact.portal_user != null)`;
const admissible = `vendor != null && vendor.status != 'blacklisted'`;
const isPortalAdmin = `invite.portal_admin == true`;

const assign = (id: string, label: string, position: string): Automation.FlowNode => ({
  id,
  type: 'create_record',
  label,
  config: {
    objectName: 'sys_user_position',
    fields: { user_id: cel`portal_account`, position, organization_id: cel`member.organization_id` },
  },
});

export const PortalEnableFlow: Automation.Flow = {
  name: 'srm_portal_enable',
  label: '开通门户',
  type: 'screen',
  status: 'active',
  runAs: 'user',
  successMessage: '门户已开通：该用户下一次请求起可以看到本公司的数据',

  variables: [{ name: 'recordId', type: 'text', isInput: true, isOutput: false }],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load_operator',
      type: 'get_record',
      label: '操作人是组织管理员？',
      config: {
        objectName: 'sys_member',
        filter: { user_id: c(`current_user != null ? current_user.id : ''`), role: { $in: ORG_ADMIN_ROLES } },
        outputVariable: 'operator',
      },
    },
    { id: 'gate_admin', type: 'decision', label: '组织管理员？' },
    {
      id: 'refuse_admin',
      type: 'end',
      label: '不是组织管理员',
      config: { outcome: 'refused', message: '门户由组织管理员开通；品类经理、采购主管请新建门户邀请，由组织管理员处理' },
    },
    {
      id: 'load',
      type: 'get_record',
      label: '读取门户邀请',
      config: { objectName: 'srm_supplier_invitation', filter: { id: cel`recordId` }, outputVariable: 'invite' },
    },
    {
      id: 'load_contact',
      type: 'get_record',
      label: '读取联系人',
      config: { objectName: 'srm_supplier_contact', filter: { id: c(`invite != null ? invite.contact : ''`) }, outputVariable: 'contact' },
    },
    {
      id: 'load_supplier',
      type: 'get_record',
      label: '读取供应商',
      config: { objectName: 'srm_supplier', filter: { id: c(`invite != null ? invite.supplier : ''`) }, fields: ['name', 'status'], outputVariable: 'vendor' },
    },
    { id: 'gate', type: 'decision', label: '可以开通？' },
    {
      id: 'refuse_status',
      type: 'end',
      label: '不是待开通',
      config: { outcome: 'refused', message: '只有「已发送」的门户邀请可以开通；已过期或已撤销的请品类经理重新邀请' },
    },
    {
      id: 'refuse_blacklisted',
      type: 'end',
      label: '黑名单供应商',
      config: { outcome: 'refused', message: '黑名单供应商不能开通门户' },
    },
    {
      id: 'refuse_contact',
      type: 'end',
      label: '联系人不可开通',
      config: { outcome: 'refused', message: '联系人已停用或已开通门户账号' },
    },
    {
      id: 'pick',
      type: 'screen',
      label: '选择门户账号',
      config: {
        title: '开通门户：{{ vendor.name }}',
        description:
          '联系人：{{ contact.name }}　邀请邮箱：{{ invite.contact_email }}\n'
          + '请先在组织成员页按这个邮箱发出邀请（角色选 external），对方注册并接受邀请后，在这里选择该用户。'
          + '开通后该用户只能看到这家供应商的数据。',
        fields: [{ name: 'portal_account', label: '门户账号', type: 'lookup', reference: 'sys_user', required: true }],
      },
    },
    {
      id: 'load_member',
      type: 'get_record',
      label: '读取所选用户的组织成员身份',
      config: {
        objectName: 'sys_member',
        filter: { user_id: cel`portal_account`, organization_id: cel`operator.organization_id` },
        outputVariable: 'member',
      },
    },
    {
      id: 'load_taken',
      type: 'get_record',
      label: '所选用户已登记在联系人上？',
      config: { objectName: 'srm_supplier_contact', filter: { portal_user: cel`portal_account` }, outputVariable: 'taken' },
    },
    { id: 'check', type: 'decision', label: '所选用户合适？' },
    {
      id: 'refuse_member',
      type: 'end',
      label: '还不是组织成员',
      config: { outcome: 'refused', message: '该用户还没有加入组织：请先在成员页按邀请邮箱发出邀请（角色 external），对方接受后再开通' },
    },
    {
      id: 'refuse_role',
      type: 'end',
      label: '不是外部成员',
      config: { outcome: 'refused', message: '门户账号必须以 external（外部成员）角色加入组织；内部员工不能开通为门户账号' },
    },
    {
      id: 'refuse_taken',
      type: 'end',
      label: '已登记在别的联系人上',
      config: { outcome: 'refused', message: '该用户已经是另一位联系人的门户账号；一个门户账号只能对应一位联系人' },
    },
    {
      id: 'load_held_user',
      type: 'get_record',
      label: '已任命门户用户岗位？',
      config: { objectName: 'sys_user_position', filter: { user_id: cel`portal_account`, position: PORTAL_USER }, outputVariable: 'heldUser' },
    },
    {
      id: 'load_held_admin',
      type: 'get_record',
      label: '已任命门户管理员岗位？',
      config: { objectName: 'sys_user_position', filter: { user_id: cel`portal_account`, position: PORTAL_ADMIN }, outputVariable: 'heldAdmin' },
    },
    { id: 'need_user', type: 'decision', label: '任命门户用户？' },
    assign('assign_user', '任命到门户用户岗位', PORTAL_USER),
    { id: 'need_admin', type: 'decision', label: '任命门户管理员？' },
    assign('assign_admin', '任命到门户管理员岗位', PORTAL_ADMIN),
    {
      id: 'roster',
      type: 'subflow',
      label: '登记门户账号',
      config: {
        flowName: 'srm_portal_roster_write',
        input: {
          invitationId: cel`invite.id`,
          contactId: cel`contact.id`,
          userId: cel`portal_account`,
          operatorId: cel`current_user.id`,
        },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load_operator', type: 'default' },
    { id: 'e1', source: 'load_operator', target: 'gate_admin', type: 'default' },
    { id: 'e_not_admin', source: 'gate_admin', target: 'refuse_admin', type: 'conditional', condition: c(`!(${isAdmin})`), label: '不是' },
    { id: 'e_admin', source: 'gate_admin', target: 'load', type: 'conditional', condition: c(isAdmin), label: '是' },
    { id: 'e2', source: 'load', target: 'load_contact', type: 'default' },
    { id: 'e3', source: 'load_contact', target: 'load_supplier', type: 'default' },
    { id: 'e4', source: 'load_supplier', target: 'gate', type: 'default' },
    { id: 'e_status', source: 'gate', target: 'refuse_status', type: 'conditional', condition: c(`!(${open})`), label: '不是待开通' },
    {
      id: 'e_blacklisted',
      source: 'gate',
      target: 'refuse_blacklisted',
      type: 'conditional',
      condition: c(`${open} && !(${admissible})`),
      label: '黑名单',
    },
    {
      id: 'e_contact',
      source: 'gate',
      target: 'refuse_contact',
      type: 'conditional',
      condition: c(`${open} && ${admissible} && !(${ready})`),
      label: '联系人不可开通',
    },
    { id: 'e_ok', source: 'gate', target: 'pick', type: 'conditional', condition: c(`${open} && ${admissible} && ${ready}`), label: '可以' },
    { id: 'e5', source: 'pick', target: 'load_member', type: 'default' },
    { id: 'e6', source: 'load_member', target: 'load_taken', type: 'default' },
    { id: 'e7', source: 'load_taken', target: 'check', type: 'default' },
    { id: 'e_no_member', source: 'check', target: 'refuse_member', type: 'conditional', condition: P`member == null`, label: '不是成员' },
    { id: 'e_role', source: 'check', target: 'refuse_role', type: 'conditional', condition: P`member != null && member.role != 'external'`, label: '不是外部成员' },
    {
      id: 'e_taken',
      source: 'check',
      target: 'refuse_taken',
      type: 'conditional',
      condition: P`member != null && member.role == 'external' && taken != null`,
      label: '已登记',
    },
    {
      id: 'e_fit',
      source: 'check',
      target: 'load_held_user',
      type: 'conditional',
      condition: P`member != null && member.role == 'external' && taken == null`,
      label: '合适',
    },
    { id: 'e8', source: 'load_held_user', target: 'load_held_admin', type: 'default' },
    { id: 'e9', source: 'load_held_admin', target: 'need_user', type: 'default' },
    { id: 'e_assign_user', source: 'need_user', target: 'assign_user', type: 'conditional', condition: P`heldUser == null`, label: '未任命' },
    { id: 'e_has_user', source: 'need_user', target: 'need_admin', type: 'conditional', condition: P`heldUser != null`, label: '已任命' },
    { id: 'e10', source: 'assign_user', target: 'need_admin', type: 'default' },
    {
      id: 'e_assign_admin',
      source: 'need_admin',
      target: 'assign_admin',
      type: 'conditional',
      condition: c(`${isPortalAdmin} && heldAdmin == null`),
      label: '主账号，未任命',
    },
    {
      id: 'e_no_admin',
      source: 'need_admin',
      target: 'roster',
      type: 'conditional',
      condition: c(`!(${isPortalAdmin}) || heldAdmin != null`),
      label: '不需要',
    },
    { id: 'e11', source: 'assign_admin', target: 'roster', type: 'default' },
    { id: 'e12', source: 'roster', target: 'end', type: 'default' },
  ],
};

// 名册写入（ADR-0010「授权就是写名册」）：只由 srm_portal_enable 调用。portal_user 字段级只读，只有系统身份写得进去；
// 平台拒绝任何调用者直接启动系统身份的 autolaunched flow。写入前自己再核一遍「一人一号」（该用户没有登记在任何联系人上），
// 写入条件也限定联系人在职、尚未登记门户账号、邀请仍是已发送，免得并发的两次开通互相覆盖
export const PortalRosterWriteFlow: Automation.Flow = {
  name: 'srm_portal_roster_write',
  label: '登记门户账号',
  type: 'autolaunched',
  status: 'active',
  runAs: 'system',

  variables: [
    { name: 'invitationId', type: 'text', isInput: true, isOutput: false },
    { name: 'contactId', type: 'text', isInput: true, isOutput: false },
    { name: 'userId', type: 'text', isInput: true, isOutput: false },
    { name: 'operatorId', type: 'text', isInput: true, isOutput: false },
  ],

  nodes: [
    { id: 'start', type: 'start', label: '开始' },
    {
      id: 'load_taken',
      type: 'get_record',
      label: '该用户已登记在联系人上？',
      config: { objectName: 'srm_supplier_contact', filter: { portal_user: cel`userId` }, outputVariable: 'taken' },
    },
    { id: 'check', type: 'decision', label: '一人一号？' },
    {
      id: 'refuse_taken',
      type: 'end',
      label: '已登记在别的联系人上',
      config: { outcome: 'refused', message: '该用户已经是另一位联系人的门户账号；一个门户账号只能对应一位联系人' },
    },
    {
      id: 'write_contact',
      type: 'update_record',
      label: '联系人写入门户账号',
      config: {
        objectName: 'srm_supplier_contact',
        filter: { id: cel`contactId`, active: true, portal_user: null },
        // 带条件的写（比对后写入）要走 multi 路径，平台才按全部条件匹配，至多写这一行
        multi: true,
        fields: { portal_user: cel`userId` },
      },
    },
    {
      id: 'write_invitation',
      type: 'update_record',
      label: '邀请置为已开通',
      config: {
        objectName: 'srm_supplier_invitation',
        filter: { id: cel`invitationId`, status: 'sent' },
        multi: true,
        fields: { status: 'accepted', portal_user: cel`userId`, enabled_by: cel`operatorId`, enabled_at: cel`isoDatetime(now())` },
      },
    },
    { id: 'end', type: 'end', label: '结束' },
  ],

  edges: [
    { id: 'e0', source: 'start', target: 'load_taken', type: 'default' },
    { id: 'e1', source: 'load_taken', target: 'check', type: 'default' },
    { id: 'e_taken', source: 'check', target: 'refuse_taken', type: 'conditional', condition: P`taken != null`, label: '已登记' },
    { id: 'e_free', source: 'check', target: 'write_contact', type: 'conditional', condition: P`taken == null`, label: '未登记' },
    { id: 'e2', source: 'write_contact', target: 'write_invitation', type: 'default' },
    { id: 'e3', source: 'write_invitation', target: 'end', type: 'default' },
  ],
};
