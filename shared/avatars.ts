/**
 * Curated avatar library for children aged 1-8.
 *
 * Avatars are emoji-based — no image files to manage, no S3 uploads,
 * and they render crisply at any size on every device. The emoji are
 * organised into kid-friendly categories so the picker can display
 * them in groups.
 */

export interface AvatarCategory {
  name: string;
  emoji: string[];
}

export const AVATAR_CATEGORIES: AvatarCategory[] = [
  {
    name: "Animals",
    emoji: [
      "🐱", "🐶", "🐰", "🦊", "🐻", "🐼", "🐨", "🦁", "🐯", "🐸",
      "🐵", "🦄", "🐙", "🦋", "🐢", "🐧", "🦉", "🦕", "🐬", "🦓",
    ],
  },
  {
    name: "Nature & Space",
    emoji: [
      "🌈", "⭐", "🌙", "☀️", "🌸", "🌻", "🍀", "🌳", "🌊", "🌋",
      "🪐", "☄️", "⚡", "❄️", "🔥", "🌍", "🌵", "🍁", "🌺", "🍄",
    ],
  },
  {
    name: "Food",
    emoji: [
      "🍎", "🍌", "🍓", "🍇", "🍉", "🥕", "🌽", "🍕", "🍦", "🧁",
      "🍩", "🍪", "🍫", "🍭", "🥐", "🧀", "🥑", "🍒", "🥝", "🍍",
    ],
  },
  {
    name: "Fun & Play",
    emoji: [
      "🎈", "🎁", "🎉", "🎨", "🎭", "🎪", "🎯", "🎲", "🧩", "🎸",
      "🎺", "🥁", "🎤", "🎧", "🪁", "🚂", "🚀", "✈️", "🚲", "⛵",
    ],
  },
  {
    name: "Characters",
    emoji: [
      "🤖", "👻", "👽", "🦖", "🐲", "🧚", "🧜", "🧛", "🦸", "🦹",
      "👸", "🤴", "🎅", "🤡", "🥳", "😎", "🤠", "🧙", "🦲", "👼",
    ],
  },
  {
    name: "Sports",
    emoji: [
      "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏉", "🎱", "🏓", "🏸",
      "🥊", "🥋", "🤿", "🏂", "⛷️", "🏌️", "🏇", "🤸", "🤽", "🏆",
    ],
  },
];

/** All avatar emoji flattened into a single array. */
export const ALL_AVATARS: string[] = AVATAR_CATEGORIES.flatMap((c) => c.emoji);

/** Default avatar used when a child hasn't picked one yet. */
export const DEFAULT_AVATAR = "🌟";

/** Maps child colour names to hex values (mirrors scripts/config.ts). */
export const CHILD_COLOR_HEX: Record<string, string> = {
  red: "#e53935",
  green: "#43a047",
  blue: "#5b6cff",
  orange: "#fb8c00",
  purple: "#8e24aa",
};

/** Converts a hex colour (#rrggbb) to an rgba() string with the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Returns the avatar emoji for a child, or the default if not set. */
export function childAvatar(avatar: string | undefined | null): string {
  return avatar && ALL_AVATARS.includes(avatar) ? avatar : DEFAULT_AVATAR;
}
