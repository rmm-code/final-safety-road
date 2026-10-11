"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * What the shell needs from whichever page is showing: whether the phone menu is open, and
 * the detail the breadcrumb shows after the section name ("Dashboard · VIDEO-2.MP4").
 */
type ShellState = {
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  detail: string | null;
  setDetail: (detail: string | null) => void;
};

const ShellContext = createContext<ShellState | null>(null);

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const value = useMemo(() => ({ menuOpen, setMenuOpen, detail, setDetail }), [menuOpen, detail]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellState {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell needs a ShellProvider");
  return shell;
}

/** Put a detail after the section name in the breadcrumb while this page is mounted. */
export function useBreadcrumb(detail: string | null): void {
  const { setDetail } = useShell();
  useEffect(() => {
    setDetail(detail);
    return () => setDetail(null);
  }, [detail, setDetail]);
}
