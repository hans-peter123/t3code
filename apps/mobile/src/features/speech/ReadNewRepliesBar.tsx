import { useAtomMount } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { readNewRepliesWatcher, setReadNewReplies, useReadNewReplies } from "./readNewReplies";

// The thread screen focused last. Sheets over it keep it reading; another thread replaces it.
let reader: object | null = null;
const readerListeners = new Set<() => void>();

function setReader(next: object | null) {
  reader = next;
  for (const listener of readerListeners) listener();
}

function subscribeReader(listener: () => void) {
  readerListeners.add(listener);
  return () => readerListeners.delete(listener);
}

function useIsReader(): boolean {
  const [self] = useState(() => ({}));
  useFocusEffect(useCallback(() => setReader(self), [self]));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the module-level reader slot when this screen unmounts.
  useEffect(
    () => () => {
      if (reader === self) setReader(null);
    },
    [self],
  );
  return useSyncExternalStore(subscribeReader, () => reader === self);
}

/** Above the composer while "Read new replies" is on, and the thread's reader while it shows. */
export function ReadNewRepliesBar(props: { readonly threadRef: ScopedThreadRef | null }) {
  const { available, enabled } = useReadNewReplies();
  const active = available && enabled;
  const isReader = useIsReader();
  useAtomMount(readNewRepliesWatcher(active && isReader ? props.threadRef : null));
  if (!active) return null;
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="speaker.wave.2" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Reading new replies while the app is open
      </Text>
      <Button label="Turn off" tone="text" onPress={() => setReadNewReplies(false)} />
    </View>
  );
}
