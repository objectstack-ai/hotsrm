import { defineStack } from '@objectstack/spec';
import * as objects from './objects/index.js';
import * as picklists from './picklists/index.js';
import * as views from './views/index.js';
import * as flows from './flows/index.js';
import * as apps from './apps/index.js';
import * as translations from './translations/index.js';
import { SrmSeedData } from './data/index.js';

// 通用核心（type: app，命名空间 srm）。扩展包在 objectstack.config.ts 里与它合成一个应用。
export default defineStack({
  manifest: {
    id: 'app.objectstack.hotsrm',
    namespace: 'srm',
    version: '0.1.0',
    type: 'app',
    name: 'hotsrm',
    description: '供应商关系管理（SRM）',
    engines: { protocol: '^18.0.0' },
  },

  // auth + ui：登录页和控制台；automation + triggers：运行记录触发的 flow；approvals：flow 里的审批节点。
  requires: ['auth', 'ui', 'automation', 'triggers', 'approvals'],

  data: SrmSeedData,

  objects: Object.values(objects),
  picklists: Object.values(picklists),
  views: Object.values(views),
  flows: Object.values(flows),
  apps: Object.values(apps),

  i18n: {
    defaultLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'],
    fallbackLocale: 'zh-CN',
  },
  translations: Object.values(translations),
});
