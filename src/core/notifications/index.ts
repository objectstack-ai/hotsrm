// 供应商侧通知模板（05 §5，v0.6 U6）。平台按收件人的语言（sys_user.locale，未设时取部署默认语言 zh-CN）在
// (name, locale) 上精确查找，查不到时退到 en-US，所以每个模板都写 zh-CN 和 en-US 两份；英文用户选 en 时落到 en-US。
// 同一份模板既发邮件也进站内信（站内信点开即跳到单据）。正文只写单号、事件和「登录门户查看」：
// 不放金额、银行账号、扣分明细等内容（05 §5、07 R5）。邮件里的完整链接需要部署地址，模板上下文里没有，
// 只给出 {{ path }}（如 /srm_quality_issue/<id>），客户可以在模板覆盖层里写上自己的门户域名拼成链接。
type Copy = { subject: string; body: string };
type Template = { name: string; label: string; variables: string[]; zh: Copy; en: Copy };

const TEMPLATES: Template[] = [
  {
    name: 'srm_portal_opened',
    label: '门户已开通',
    variables: ['supplier'],
    zh: {
      subject: '{{ supplier }}：供应商门户账号已开通',
      body: '您好，{{ supplier }} 的供应商门户账号已开通。登录 {{ appName }} 后可以维护公司资料、资质证书和银行账户；收到准入邀请的，请补齐资料后在公司资料上点「提交准入申请」。',
    },
    en: {
      subject: '{{ supplier }}: your supplier portal account is open',
      body: 'Hello, the supplier portal account of {{ supplier }} is now open. Sign in to {{ appName }} to maintain your company profile, certificates and bank accounts; if you were invited to qualify, complete your profile and click "Submit Admission Application" on your company profile.',
    },
  },
  {
    name: 'srm_application_accepted',
    label: '准入申请已受理',
    variables: ['no', 'supplier'],
    zh: {
      subject: '准入申请 {{ no }} 已受理',
      body: '{{ supplier }} 的准入申请 {{ no }} 已受理，品类经理正在审核资料。审核中如需补充，我们会再通知您。详情请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'Admission application {{ no }} received',
      body: 'The admission application {{ no }} of {{ supplier }} has been received and the category manager is reviewing your documents. We will let you know if anything needs supplementing. Sign in to the {{ appName }} supplier portal for details.',
    },
  },
  {
    name: 'srm_application_returned',
    label: '准入申请退回补充',
    variables: ['no', 'supplier'],
    zh: {
      subject: '准入申请 {{ no }} 需要补充资料',
      body: '{{ supplier }} 的准入申请 {{ no }} 已退回补充。请登录 {{ appName }} 供应商门户查看退回意见，补齐后在申请上点「补充完成，重新提交」。',
    },
    en: {
      subject: 'Admission application {{ no }} needs more information',
      body: 'The admission application {{ no }} of {{ supplier }} has been returned for more information. Sign in to the {{ appName }} supplier portal to see what is needed, then click "Supplemented, Resubmit" on the application.',
    },
  },
  {
    name: 'srm_application_approved',
    label: '准入申请已通过',
    variables: ['no', 'supplier'],
    zh: {
      subject: '准入申请 {{ no }} 已通过',
      body: '{{ supplier }} 的准入申请 {{ no }} 已审批通过，贵司已成为合格供应商。详情请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'Admission application {{ no }} approved',
      body: 'The admission application {{ no }} of {{ supplier }} has been approved and your company is now a qualified supplier. Sign in to the {{ appName }} supplier portal for details.',
    },
  },
  {
    name: 'srm_application_rejected',
    label: '准入申请未通过',
    variables: ['no', 'supplier'],
    zh: {
      subject: '准入申请 {{ no }} 未通过',
      body: '{{ supplier }} 的准入申请 {{ no }} 未通过。原因请登录 {{ appName }} 供应商门户查看，或联系对接的品类经理。',
    },
    en: {
      subject: 'Admission application {{ no }} not approved',
      body: 'The admission application {{ no }} of {{ supplier }} was not approved. Sign in to the {{ appName }} supplier portal for the reason, or contact your category manager.',
    },
  },
  {
    name: 'srm_certificate_expiring',
    label: '资质证书即将到期',
    variables: ['supplier', 'cert_no', 'valid_to'],
    zh: {
      subject: '{{ supplier }}：资质证书将于 {{ valid_to | date }} 到期',
      body: '{{ supplier }} 的一份资质证书（编号 {{ cert_no }}）将于 {{ valid_to | date }} 到期。请及时换证，并登录 {{ appName }} 供应商门户上传新证书，SQE 核验后生效。',
    },
    en: {
      subject: '{{ supplier }}: a certificate expires on {{ valid_to | date }}',
      body: 'A certificate of {{ supplier }} (No. {{ cert_no }}) expires on {{ valid_to | date }}. Please renew it and upload the new certificate in the {{ appName }} supplier portal; it takes effect once our SQE has verified it.',
    },
  },
  {
    name: 'srm_certificate_expired',
    label: '资质证书已过期',
    variables: ['supplier', 'cert_no', 'valid_to'],
    zh: {
      subject: '{{ supplier }}：资质证书已过期',
      body: '{{ supplier }} 的一份资质证书（编号 {{ cert_no }}）已于 {{ valid_to | date }} 过期。必备资质过期会影响供货资格，请尽快登录 {{ appName }} 供应商门户上传新证书。',
    },
    en: {
      subject: '{{ supplier }}: a certificate has expired',
      body: 'A certificate of {{ supplier }} (No. {{ cert_no }}) expired on {{ valid_to | date }}. An expired mandatory certificate affects your qualification to supply; please upload the new certificate in the {{ appName }} supplier portal as soon as possible.',
    },
  },
  {
    name: 'srm_scar_new',
    label: '新整改单',
    variables: ['no', 'supplier', 'containment_due', 'final_due'],
    zh: {
      subject: '新整改单 {{ no }}：请提交临时措施',
      body: '{{ supplier }} 有一张新的整改单 {{ no }}。请在 {{ containment_due | datetime }} 前提交临时措施（D3），在 {{ final_due | date }} 前提交根因与永久措施（D4–D7）。问题描述和回复入口请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'New corrective action request {{ no }}: containment needed',
      body: '{{ supplier }} has a new corrective action request {{ no }}. Please submit containment (D3) by {{ containment_due | datetime }} and root cause with permanent actions (D4–D7) by {{ final_due | date }}. Sign in to the {{ appName }} supplier portal to see the problem and reply.',
    },
  },
  {
    name: 'srm_scar_returned',
    label: '整改措施被退回',
    variables: ['no', 'supplier', 'final_due'],
    zh: {
      subject: '整改单 {{ no }} 的根因与措施被退回',
      body: '{{ supplier }} 提交的整改单 {{ no }} 根因与措施（D4–D7）已被 SQE 退回。请登录 {{ appName }} 供应商门户查看退回意见，修改后在 {{ final_due | date }} 前重新提交。',
    },
    en: {
      subject: 'Root cause and actions returned on {{ no }}',
      body: 'Our SQE has returned the root cause and actions (D4–D7) that {{ supplier }} submitted on corrective action request {{ no }}. Sign in to the {{ appName }} supplier portal to see the comments, and resubmit by {{ final_due | date }}.',
    },
  },
  {
    name: 'srm_scar_reopened',
    label: '整改单重新打开',
    variables: ['no', 'supplier', 'containment_due', 'final_due'],
    zh: {
      subject: '整改单 {{ no }} 因问题复发重新打开',
      body: '{{ supplier }} 的整改单 {{ no }} 因问题复发重新打开。请在 {{ containment_due | datetime }} 前重新提交临时措施（D3），在 {{ final_due | date }} 前提交根因与永久措施（D4–D7）。详情请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'Corrective action request {{ no }} reopened',
      body: 'Corrective action request {{ no }} of {{ supplier }} has been reopened because the problem recurred. Please resubmit containment (D3) by {{ containment_due | datetime }} and root cause with permanent actions (D4–D7) by {{ final_due | date }}. Sign in to the {{ appName }} supplier portal for details.',
    },
  },
  {
    name: 'srm_scar_overdue',
    label: '整改单逾期',
    variables: ['no', 'supplier', 'containment_due', 'final_due'],
    zh: {
      subject: '整改单 {{ no }} 已逾期',
      body: '{{ supplier }} 的整改单 {{ no }} 已超过回复期限（临时措施 {{ containment_due | datetime }}，根因与措施 {{ final_due | date }}）。请尽快登录 {{ appName }} 供应商门户回复。',
    },
    en: {
      subject: 'Corrective action request {{ no }} is overdue',
      body: 'Corrective action request {{ no }} of {{ supplier }} is past its reply deadline (containment {{ containment_due | datetime }}, root cause and actions {{ final_due | date }}). Please reply in the {{ appName }} supplier portal as soon as possible.',
    },
  },
  {
    name: 'srm_scar_claim_proposed',
    label: '整改单提出索赔',
    variables: ['no', 'supplier'],
    zh: {
      subject: '整改单 {{ no }} 提出了索赔，请确认',
      body: '我方 SQE 已就 {{ supplier }} 的整改单 {{ no }} 提出索赔。请登录 {{ appName }} 供应商门户，在整改单上点「确认索赔」接受或提出异议。',
    },
    en: {
      subject: 'A claim was raised on corrective action request {{ no }}',
      body: 'Our SQE has raised a claim on corrective action request {{ no }} of {{ supplier }}. Sign in to the {{ appName }} supplier portal and click "Respond to Claim" on the request to accept it or dispute it.',
    },
  },
  {
    name: 'srm_review_published',
    label: '绩效结果已发布',
    variables: ['no', 'supplier', 'period', 'appeal_days'],
    zh: {
      subject: '{{ period }} 绩效考评结果已发布',
      body: '{{ supplier }} {{ period }} 的绩效考评结果（考评单 {{ no }}）已发布。请登录 {{ appName }} 供应商门户查看；对结果有异议的，可在发布后 {{ appeal_days }} 天内在门户提交一次申诉。',
    },
    en: {
      subject: 'Performance results for {{ period }} published',
      body: 'The performance review {{ no }} of {{ supplier }} for {{ period }} has been published. Sign in to the {{ appName }} supplier portal to see it; if you disagree, you may appeal once in the portal within {{ appeal_days }} days of publication.',
    },
  },
  {
    name: 'srm_appeal_resolved',
    label: '绩效申诉已处理',
    variables: ['no', 'supplier', 'period'],
    zh: {
      subject: '考评单 {{ no }} 的申诉已处理',
      body: '{{ supplier }} 对 {{ period }} 考评单 {{ no }} 的申诉已处理。处理结果请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'Appeal on performance review {{ no }} resolved',
      body: 'The appeal of {{ supplier }} on performance review {{ no }} ({{ period }}) has been resolved. Sign in to the {{ appName }} supplier portal to see the outcome.',
    },
  },
  {
    name: 'srm_bank_account_verified',
    label: '银行账户已核验',
    variables: ['supplier', 'bank'],
    zh: {
      subject: '{{ supplier }}：银行账户已核验生效',
      body: '{{ supplier }} 在 {{ bank }} 的银行账户已由我方财务核验，状态为有效。账户详情请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: '{{ supplier }}: bank account verified',
      body: 'The bank account of {{ supplier }} at {{ bank }} has been verified by our finance team and is now active. Sign in to the {{ appName }} supplier portal for the account details.',
    },
  },
  {
    name: 'srm_change_applied',
    label: '变更单已生效',
    variables: ['no', 'supplier'],
    zh: {
      subject: '变更单 {{ no }} 已审批通过并生效',
      body: '{{ supplier }} 的信息变更单 {{ no }} 已审批通过，变更内容已写入供应商档案。详情请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'Change request {{ no }} approved and applied',
      body: 'The information change request {{ no }} of {{ supplier }} has been approved and applied to your supplier record. Sign in to the {{ appName }} supplier portal for details.',
    },
  },
  {
    name: 'srm_change_rejected',
    label: '变更单已驳回',
    variables: ['no', 'supplier'],
    zh: {
      subject: '变更单 {{ no }} 已驳回',
      body: '{{ supplier }} 的信息变更单 {{ no }} 未获批准，供应商档案未作修改。驳回原因请登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: 'Change request {{ no }} rejected',
      body: 'The information change request {{ no }} of {{ supplier }} was not approved and your supplier record is unchanged. Sign in to the {{ appName }} supplier portal for the reason.',
    },
  },
  {
    name: 'srm_change_returned',
    label: '变更单退回修改',
    variables: ['no', 'supplier'],
    zh: {
      subject: '变更单 {{ no }} 退回修改',
      body: '{{ supplier }} 的信息变更单 {{ no }} 已退回修改。请登录 {{ appName }} 供应商门户查看审批意见，修改后重新提交。',
    },
    en: {
      subject: 'Change request {{ no }} returned for revision',
      body: 'The information change request {{ no }} of {{ supplier }} has been returned for revision. Sign in to the {{ appName }} supplier portal to see the comments, then revise and resubmit it.',
    },
  },
  {
    name: 'srm_supplier_frozen',
    label: '供应商已冻结',
    variables: ['supplier', 'scope'],
    zh: {
      subject: '{{ supplier }}：供货资格已冻结',
      body: '{{ supplier }} 的供货资格已冻结（范围：{{ scope }}）。冻结期间不能参与新的合作，在途业务照常；原因和后续安排请联系对接的品类经理。供货品类的状态可登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: '{{ supplier }}: qualification to supply frozen',
      body: 'The qualification of {{ supplier }} to supply has been frozen (scope: {{ scope }}). While frozen you cannot take on new business; business in progress continues. Please contact your category manager for the reason and next steps. You can see the status of your supply categories in the {{ appName }} supplier portal.',
    },
  },
  {
    name: 'srm_supplier_unfrozen',
    label: '供应商已解冻',
    variables: ['supplier', 'scope'],
    zh: {
      subject: '{{ supplier }}：供货资格已恢复',
      body: '{{ supplier }} 被冻结的供货资格已恢复（范围：{{ scope }}）。供货品类的状态可登录 {{ appName }} 供应商门户查看。',
    },
    en: {
      subject: '{{ supplier }}: qualification to supply restored',
      body: 'The frozen qualification of {{ supplier }} to supply has been restored (scope: {{ scope }}). You can see the status of your supply categories in the {{ appName }} supplier portal.',
    },
  },
  {
    name: 'srm_supplier_eliminated',
    label: '供应商已淘汰',
    variables: ['supplier'],
    zh: {
      subject: '{{ supplier }}：合格供应商资格已终止',
      body: '{{ supplier }} 的合格供应商资格已终止（淘汰），供应商门户账号随之停用。如需再次合作，须重新申请准入；具体事宜请联系对接的品类经理。',
    },
    en: {
      subject: '{{ supplier }}: qualified supplier status ended',
      body: 'The qualified supplier status of {{ supplier }} has ended (eliminated) and your supplier portal accounts are closed. Working together again requires a new admission application; please contact your category manager for details.',
    },
  },
  {
    name: 'srm_supplier_blacklisted',
    label: '供应商已列入禁入名单',
    variables: ['supplier'],
    zh: {
      subject: '{{ supplier }}：合格供应商资格已终止',
      body: '{{ supplier }} 的合格供应商资格已终止，并在禁入期内不得重新申请准入，供应商门户账号随之停用。具体事宜请联系对接的品类经理。',
    },
    en: {
      subject: '{{ supplier }}: qualified supplier status ended',
      body: 'The qualified supplier status of {{ supplier }} has ended, and no new admission application will be accepted during the exclusion period. Your supplier portal accounts are closed. Please contact your category manager for details.',
    },
  },
];

export const SUPPLIER_TEMPLATE_NAMES = TEMPLATES.map((t) => t.name);

const html = (body: string) => `<p>${body}</p>`;
const variablesOf = (t: Template) => [...t.variables, 'path'].map((name) => ({ name, type: 'string' as const, required: false }));

export const SrmEmailTemplates = TEMPLATES.flatMap((t) => [
  { name: t.name, label: t.label, locale: 'zh-CN', subject: t.zh.subject, bodyHtml: html(t.zh.body), bodyText: t.zh.body, variables: variablesOf(t) },
  { name: t.name, label: t.label, locale: 'en-US', subject: t.en.subject, bodyHtml: html(t.en.body), bodyText: t.en.body, variables: variablesOf(t) },
]);
