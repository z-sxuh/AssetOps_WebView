import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export default function SearchToolbar({ page, open, children }: { page: string; open: boolean; children: ReactNode }) {
  const toolbar = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useLayoutEffect(() => {
    const content = toolbar.current?.parentElement?.querySelector<HTMLElement>('.content-area');
    if (!content) return;
    const update = () => setScrolled(content.scrollTop > 1);
    content.addEventListener('scroll', update, { passive: true }); update();
    return () => content.removeEventListener('scroll', update);
  }, [page]);
  const hidden = scrolled && !open;
  return <header ref={toolbar} className={`topbar${hidden ? ' is-scroll-hidden' : ''}`} aria-hidden={hidden || undefined}>{children}</header>;
}
