import { composeStacks } from '@objectstack/spec';
import core from './src/core/index.js';

// 构建时把核心与选中的扩展包合成一个制品（ADR-0002）。v0.1 只有核心；扩展包开关
// 待第一个扩展包落地时放进 objectstack.composition.ts。
export default composeStacks([core], { manifest: 'preserve' });
