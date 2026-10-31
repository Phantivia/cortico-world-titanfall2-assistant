/** Package entry: the default export is the `WorldDefinition`. */
import { TITANFALL2 } from './definition.ts';

export default TITANFALL2;

export { TITANFALL2 };
export { TITANFALL2_DEFAULTS, TITANFALL2_ID, titanfall2ConfigGroups } from './config.ts';
export type { Titanfall2ConfigSection } from './config.ts';
export { Titanfall2World, type Titanfall2WorldOptions } from './world.ts';
export { TITANFALL2_TOOL_DECLS } from './tools.ts';
