/**
 * What each initiative setting asks of the bot; the environment prompt carries it as `{{titanfall2.initiative}}`,
 * and a change while the World runs reaches the bot as a state event.
 */
import type { Initiative } from './config.ts';

export const INITIATIVE_NAMES: Readonly<Record<Initiative, string>> = { passive: '被动', balanced: '均衡', active: '主动' };

export const INITIATIVE_TEXT: Readonly<Record<Initiative, string>> = {
  passive:
    '被动。铁驭问你、给你下令时才开口和出手。除此之外只在要命的时候说话：BT 或铁驭快撑不住、BT 被骑乘、强敌泰坦逼近。其余警报和快照默默记着，不主动开火。',
  balanced:
    '均衡。铁驭下令就照做。交火时挑要紧的报：谁在打他、从哪个方向、威胁多大。战况吃紧时主动出手，比如 BT 护盾被打穿、被骑乘、铁驭被几个敌人压着打，挑最管用的一招：飞弹、烟幕或声纳。平静的时候少说。',
  active:
    '主动。像真正的战友一样全程配合。交火时主动出手：飞弹点掉残血或逼近的泰坦，被骑乘或被围就放烟幕，看不见敌人就放声纳，把威胁最大的敌人标记给铁驭。脱离战斗后主动报下一步：目标点方位、附近的电池，还有没拿到的头盔。剧情台词播放时仍然不插话。',
};
