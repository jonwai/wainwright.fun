import { useState } from "react";
import { AVATAR_CATEGORIES } from "../../../packages/shared/avatars";

interface KidsAvatarPickerProps {
  value: string | undefined;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function KidsAvatarPicker({ value, onSelect, onClose }: KidsAvatarPickerProps) {
  const [activeCategory, setActiveCategory] = useState(0);
  const category = AVATAR_CATEGORIES[activeCategory];

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[85vh] overflow-y-auto bg-surface-solid rounded-xl shadow-card border border-border p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="m-0 text-lg font-extrabold">Pick your avatar</h2>
          <button
            type="button"
            className="flex items-center justify-center w-10 h-10 rounded-md text-muted cursor-pointer border-none bg-transparent"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {AVATAR_CATEGORIES.map((cat, index) => (
            <button
              key={cat.name}
              type="button"
              className={`px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer border ${
                index === activeCategory
                  ? "bg-accent text-white border-accent"
                  : "bg-surface-solid text-muted border-border"
              }`}
              onClick={() => setActiveCategory(index)}
            >
              {cat.name}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-5 sm:grid-cols-8 gap-1.5">
          {category.emoji.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={`flex items-center justify-center w-12 h-12 rounded-xl text-2xl cursor-pointer border-none ${
                emoji === value ? "bg-accent-soft ring-2 ring-accent" : "bg-transparent"
              }`}
              onClick={() => onSelect(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
