import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Setter = (title: string | null) => void;

const SetTitle = createContext<Setter>(() => {});
const Title = createContext<string | null>(null);

/** Holds the last breadcrumb a page names itself, such as the subject of the open post. */
export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <SetTitle.Provider value={setTitle}>
      <Title.Provider value={title}>{children}</Title.Provider>
    </SetTitle.Provider>
  );
}

/** Names the current page in the breadcrumb while it is mounted. */
export function usePageTitle(title: string | null) {
  const set = useContext(SetTitle);
  useEffect(() => {
    set(title);
    return () => set(null);
  }, [set, title]);
}

export const usePageTitleValue = () => useContext(Title);
