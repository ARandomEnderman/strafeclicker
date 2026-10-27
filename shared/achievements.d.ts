export interface AchievementSubject {
  stats: Record<string, any>;
  perks: Record<string, number>;
  balance: number;
  inventoryValue: number;
}
export interface Achievement {
  id: string;
  name: string;
  desc: string;
  icon: string;
  /** Cash reward, USD. */
  reward: number;
  /** Progress is an amount of money. */
  usd?: boolean;
  goal(s: AchievementSubject): [number, number];
}
export const ACHIEVEMENTS: Achievement[];
export function newlyMet(s: AchievementSubject, unlocked: Record<string, number>): string[];
