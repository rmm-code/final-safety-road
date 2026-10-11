"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Server-state layer.
 *
 * Every view that reads from the API goes through TanStack Query rather than hand-rolled
 * effects: it removes the load/error/refetch bookkeeping from each page and keeps the
 * map, dashboard and lists sharing one cache instead of racing each other.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // A 401 means sign in, not retry; retrying only delays the message.
            retry: (failureCount, error) =>
              failureCount < 2 && !(error as { status?: number }).status?.toString().startsWith("4"),
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
