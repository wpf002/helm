// Search across the scrollback. A terminal you keep open all day accumulates
// tens of thousands of lines, and without this the only way back to something
// you saw an hour ago is scrolling for it.

import { useEffect, useRef, useState } from 'react';

interface Props {
  onSearch: (query: string, direction: 'next' | 'previous') => boolean;
  onClose: () => void;
}

export function FindBar({ onSearch, onClose }: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [miss, setMiss] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const run = (direction: 'next' | 'previous'): void => {
    if (!query) return;
    setMiss(!onSearch(query, direction));
  };

  return (
    <div className="find">
      <input
        ref={inputRef}
        className={`find__input${miss ? ' find__input--miss' : ''}`}
        value={query}
        placeholder="Find in scrollback"
        onChange={(event) => {
          setQuery(event.target.value);
          setMiss(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            run(event.shiftKey ? 'previous' : 'next');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <button className="find__btn" onClick={() => run('previous')} title="Previous (⇧⏎)">
        ↑
      </button>
      <button className="find__btn" onClick={() => run('next')} title="Next (⏎)">
        ↓
      </button>
      <button className="find__btn find__btn--close" onClick={onClose} title="Close (esc)">
        ×
      </button>
    </div>
  );
}
