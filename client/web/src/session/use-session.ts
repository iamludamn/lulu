import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BotStore } from "./store";

export function useBot(botId: string) {
  const store = useMemo(() => new BotStore(botId), [botId]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, snapshot };
}
