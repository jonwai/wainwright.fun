/**
 * Shared emoji defaults for the Tickets app cards — the "sensible defaults"
 * for the photo + emoji fallback system. Photos win when present; these
 * emoji are what a card shows otherwise (and what the placeholder icon
 * tiles in public/ticket-icons/ are generated from).
 *
 * Keys are reward_id / task_id. Keep in sync with the catalogue in
 * scripts/seed-rewards.ts.
 */

/** reward_id → emoji (see scripts/seed-rewards.ts for the catalogue). */
export const REWARD_EMOJI: Record<string, string> = {
  candy: "🍬",
  "temporary-tattoo": "🖌️",
  "choose-a-song": "🎵",
  "extra-screen-time": "⏱️",
  "felt-tip-pen": "🖍️",
  "sticker-sheet": "⭐",
  "small-toy": "🧸",
  "play-doh-tub": "🎨",
  "movie-night-popcorn": "🍿",
  "colouring-book": "📖",
  "pick-a-movie": "🎬",
  "stay-up-late": "🌙",
  "trip-to-the-park": "🛝",
  "ice-cream-treat": "🍦",
  "bubble-wand": "🫧",
  "choose-dinner": "🍽️",
  "abbey-pumping-station": "🚂",
  "happy-meal-treat": "🍔",
  "new-book": "📚",
  "cinema-trip": "🎟️",
  "craft-kit": "✂️",
  "king-richard-iii-centre": "👑",
  "soft-play-session": "🛝",
  "invite-a-friend-over": "🧒",
  "conkers-trip": "🌳",
  "big-toy": "🎁",
  "great-central-railway": "🚂",
  "twinlakes-trip": "🎡",
  "wicksteed-park-trip": "🎠",
  "twycross-zoo-trip": "🦓",
  "space-centre-trip": "🚀",
  "warwick-castle-trip": "🏰",
  "thorpe-park-trip": "🎢",
  "alton-towers-trip": "🎢",
  "london-day-trip": "🚆",
  "overnight-adventure": "⛺",
};

/** task_id → emoji (the four live tasks). */
export const TASK_EMOJI: Record<string, string> = {
  "fill-the-dishwasher": "🍽️",
  "brushing-floor": "🧹",
  "cleaning-kitchen": "🧽",
  "tidying-toys": "🧸",
};
