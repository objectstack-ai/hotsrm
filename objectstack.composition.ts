import core from './src/core/index.js';

// 选出要合成进制品的模块（ADR-0002）。目前只有核心；扩展包落地后在这里按开关加入，
// 两个扩展包同时选中时带上对应的桥接模块。
// objectstack.config.ts 不能有具名导出（构建按严格的 stack schema 解析它），所以选择逻辑放在这里。
export const stacks = [core];
