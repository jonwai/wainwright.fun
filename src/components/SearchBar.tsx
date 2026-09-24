interface SearchBarProps {
  query: string;
  onQueryChange: (query: string) => void;
}

export function SearchBar({ query, onQueryChange }: SearchBarProps) {
  return (
    <label className="block">
      <span className="visually-hidden">Search apps</span>
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search apps…"
        autoComplete="off"
        spellCheck={false}
        className="w-full min-h-12 p-3.5 px-4 border border-border rounded-md bg-surface-solid text-text font-inherit text-base focus:outline-2 focus:outline-accent focus:outline-offset-2"
      />
    </label>
  );
}
