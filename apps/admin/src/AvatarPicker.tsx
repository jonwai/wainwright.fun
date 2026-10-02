import { useState } from "react";
import { AVATAR_CATEGORIES, childAvatar } from "./avatars";

interface AvatarPickerProps {
  value: string | undefined;
  onChange: (emoji: string) => void;
}

/**
 * Grid-based avatar picker. Shows all curated emoji grouped by
 * category. The currently selected avatar is highlighted.
 */
export function AvatarPicker({ value, onChange }: AvatarPickerProps) {
  const [activeCategory, setActiveCategory] = useState(0);
  const current = childAvatar(value);
  const category = AVATAR_CATEGORIES[activeCategory];

  return (
    <div className="flex flex-col gap-3">
      {/* Category tabs */}
      <div className="flex flex-wrap gap-1.5">
        {AVATAR_CATEGORIES.map((cat, i) => (
          <button
            key={cat.name}
            type="button"
            className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer border transition-colors ${
              i === activeCategory
                ? "bg-accent text-white border-accent"
                : "bg-surface-solid text-muted border-border hover:bg-surface-hover"
            }`}
            onClick={() => setActiveCategory(i)}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {/* Emoji grid */}
      <div className="grid grid-cols-10 gap-1 p-2 rounded-md bg-surface-solid border border-border">
        {category.emoji.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={`flex items-center justify-center w-9 h-9 rounded-lg text-xl cursor-pointer border-none transition-all ${
              emoji === current
                ? "bg-accent-soft ring-2 ring-accent scale-105"
                : "bg-transparent hover:bg-surface-hover"
            }`}
            onClick={() => onChange(emoji)}
            title={emoji}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Current selection */}
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Current:</span>
        <span className="text-lg">{current}</span>
      </div>
    </div>
  );
}
